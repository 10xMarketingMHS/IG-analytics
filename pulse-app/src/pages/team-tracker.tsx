import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Loader } from "@/components/loader";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { clockTime } from "@/lib/time-format";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./team-tracker.css";

// Team tracker — for the Managers, Asst. Managers and Team Leads: their team
// (your level and below, as on the Task Board), each person's numbers for a
// month or any dates; pick one for their profile, their numbers and every task:
// what they finished in the dates — who approved it, how often it went back
// for rework — and, when the dates reach today, what's open now. A task opens
// right here. Data: GET /team-tracker (server/src/routes/team-tracker.js).

type Person = {
  id: string; name: string; designation: string | null; imageUrl: string | null; code: string | null; rank: number; me: boolean;
  done: number; open: number; overdue: number; pct: number | null;
  today: "working" | "ended" | "not_started" | "leave" | "half_day"; startedAt: string | null;
};
type TrackTask = {
  id: string; ref: string | null; title: string; status: "todo" | "in_progress" | "review" | "done"; taskType: string; onHold: boolean; revision: number;
  due: string | null; completedAt: string | null; createdAt: string; typeName: string | null; typeIcon: string | null; brand: string | null;
  points: number | null; jobs: number; budgetHours: number | null; hoursUsed: number; deliveryLink: string | null; late: boolean; given: boolean;
  approvedBy: string | null; closedBySelf: boolean; approvedAt: string | null; sentBacks: number; submissions: number; waitingFor: string | null;
};
type Detail = {
  from: string; to: string; month: string; dates: boolean; live: boolean;
  profile: { id: string; name: string; designation: string | null; imageUrl: string | null; code: string | null; active: boolean; since: string;
    leadName: string | null; email: string | null; loginOn: boolean | null; brands: string[]; rank: number };
  score: { pct: number | null; goalPoints: number; reached: number; types: { name: string; icon: string | null; goal: number; done: number }[]; otherHours: number; creditHours: number } | null;
  totals: { done: number; points: number; late: number; onTime: number; sentBack: number; open: number; hoursWorked: number; daysWorked: number; attendance: Record<string, number> };
  tasks: TrackTask[];
};
// what the page shows: a month, or any dates
type Period = { month: string } | { from: string; to: string };

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const thisMonth = () => istToday().slice(0, 7);
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const shiftMonth = (m: string, by: number) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7); };
const monthWords = (m: string) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const dayWords = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
const periodWords = (p: Period) => ("month" in p ? monthWords(p.month) : p.from === p.to ? dayWords(p.from) : `${dayWords(p.from)} – ${dayWords(p.to)}`);
const periodQuery = (p: Period) => ("month" in p ? `month=${p.month}` : `from=${p.from}&to=${p.to}`);
const TODAY_WORDS: Record<Person["today"], string> = { working: "Working", ended: "Day ended", not_started: "Not started", leave: "On leave", half_day: "Half day" };
const STATUS_WORDS: Record<TrackTask["status"], string> = { todo: "To do", in_progress: "In progress", review: "In review", done: "Done" };
const ATT_WORDS: [string, string][] = [["on_time", "On time"], ["late", "Late"], ["half_day", "Half day"], ["leave", "Leave"], ["absent", "Absent"], ["no_sod", "No plan"]];
const pctTone = (p: number | null) => (p == null ? "" : p >= 90 ? "good" : p >= 60 ? "mid" : "low");
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function Ava({ name, image, size = 34 }: { name: string; image: string | null; size?: number }) {
  return image
    ? <img className="trk-ava" src={image} alt="" style={{ width: size, height: size }} />
    : <span className="trk-ava" style={{ width: size, height: size, background: gradFor(name), fontSize: size * 0.36 }}>{initialsOf(name)}</span>;
}

export function TeamTrackerPage() {
  const [params, setParams] = useSearchParams();
  const ymdOk = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const period: Period = ymdOk(params.get("from")) && ymdOk(params.get("to")) && params.get("from")! <= params.get("to")!
    ? { from: params.get("from")!, to: params.get("to")! }
    : { month: /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : thisMonth() };
  const picked = params.get("p");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const pq = periodQuery(period);
  useEffect(() => {
    let live = true;
    api<{ people: Person[] }>(`/team-tracker?${pq}`)
      .then((r) => { if (live) { setPeople(r.people); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : "Couldn't load your team."); });
    return () => { live = false; };
  }, [pq]);
  const set = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  const setPeriod = (p: Period) => set("month" in p
    ? { month: p.month === thisMonth() ? null : p.month, from: null, to: null }
    : { month: null, from: p.from, to: p.to });
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || (p.designation ?? "").toLowerCase().includes(s) || (p.code ?? "").toLowerCase().includes(s));
  }, [people, q]);
  // today's status and what's open belong to now: shown when the dates reach today
  const today = istToday();
  const live = "month" in period ? period.month >= thisMonth() : period.to >= today;

  if (error) return <section className="screen trk"><div className="trk-card trk-empty">{error}</div></section>;
  if (!people) return <section className="screen"><Loader label="Loading your team…" /></section>;
  return (
    <section className="screen trk">
      <div className="trk-top">
        <div className="trk-head">
          <h1>Team tracker</h1>
          <span>Your team: each person's numbers, profile and task history. Pick a name.</span>
        </div>
        <span className="trk-grow" />
        <PeriodPicker period={period} onChange={setPeriod} />
      </div>

      <div className="trk-split">
        <aside className="trk-card trk-people" aria-label="Your team">
          <label className="trk-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name" aria-label="Search a name" />
          </label>
          <div className="trk-list">
            {shown.length === 0 && <div className="trk-empty">No one matches.</div>}
            {shown.map((p) => (
              <button key={p.id} type="button" className={"trk-person" + (picked === p.id ? " on" : "")} aria-pressed={picked === p.id} onClick={() => set({ p: p.id })}>
                <Ava name={p.name} image={p.imageUrl} />
                <span className="trk-pmain">
                  <b>{p.name}{p.me ? <small> · you</small> : null}</b>
                  <small>{p.designation || "Team member"}{live ? <> · <i className={"trk-day " + p.today}>{TODAY_WORDS[p.today]}{p.today === "working" && p.startedAt ? ` since ${clockTime(p.startedAt)}` : ""}</i></> : null}</small>
                </span>
                <span className="trk-pnums">
                  <span title="Done in these dates"><b>{p.done}</b> done</span>
                  {live && <span title="Open now" className={p.overdue ? "bad" : ""}>{p.open} open{p.overdue ? ` · ${p.overdue} late` : ""}</span>}
                </span>
                <span className={"trk-pct " + pctTone(p.pct)} title="Goal this month">{p.pct == null ? "—" : `${Math.round(p.pct)}%`}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="trk-detail">
          {picked ? <PersonView key={`${picked}:${pq}`} id={picked} period={period} />
            : <div className="trk-card trk-empty trk-pick">Pick a name to see their profile and task history.</div>}
        </div>
      </div>
    </section>
  );
}

// A month (‹ November 2026 ›), or dates: Today, Yesterday, the last 7 days, or any from–to
function PeriodPicker({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const today = istToday();
  const isDates = !("month" in period);
  const [open, setOpen] = useState(isDates);
  const [from, setFrom] = useState(isDates ? period.from : addDays(today, -6));
  const [to, setTo] = useState(isDates ? period.to : today);
  const quick: { label: string; p: Period }[] = [
    { label: "Today", p: { from: today, to: today } },
    { label: "Yesterday", p: { from: addDays(today, -1), to: addDays(today, -1) } },
    { label: "Last 7 days", p: { from: addDays(today, -6), to: today } },
  ];
  const same = (a: Period, b: Period) => !("month" in a) && !("month" in b) && a.from === b.from && a.to === b.to;
  return (
    <div className="trk-period">
      <div className="trk-month" role="group" aria-label="Month">
        {"month" in period ? (
          <>
            <button type="button" onClick={() => onChange({ month: shiftMonth(period.month, -1) })} aria-label="Month before">‹</button>
            <b>{monthWords(period.month)}</b>
            <button type="button" disabled={period.month >= thisMonth()} onClick={() => onChange({ month: shiftMonth(period.month, 1) })} aria-label="Month after">›</button>
          </>
        ) : (
          <button type="button" className="trk-back" onClick={() => { setOpen(false); onChange({ month: period.from.slice(0, 7) }); }}>‹ {monthWords(period.from.slice(0, 7))}</button>
        )}
        <button type="button" className={"trk-dates-btn" + (open || isDates ? " on" : "")} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
          {isDates ? periodWords(period) : "Dates"}
        </button>
      </div>
      {open && (
        <div className="trk-dates">
          {quick.map((x) => (
            <button key={x.label} type="button" className={"trk-chip-btn" + (same(period, x.p) ? " on" : "")} onClick={() => { onChange(x.p); if ("from" in x.p) { setFrom(x.p.from); setTo(x.p.to); } }}>{x.label}</button>
          ))}
          <label>From<input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="button" className="trk-apply" disabled={!from || !to || from > to}
            onClick={() => { if (!from || !to || from > to) return; onChange({ from, to }); }}>Show</button>
        </div>
      )}
    </div>
  );
}

function PersonView({ id, period }: { id: string; period: Period }) {
  const { editors } = useEditors();
  const { active, workspaces } = useWorkspaces();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<"all" | "done" | "open" | "late" | "rework">("all");
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [loadingTask, setLoadingTask] = useState<string | null>(null);
  const pq = periodQuery(period);
  async function load() {
    try {
      setD(await api<Detail>(`/team-tracker/${id}?${pq}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load them.");
    }
  }
  useEffect(() => { load(); }, [id, pq]); // eslint-disable-line react-hooks/exhaustive-deps
  // a task opens here, in its window, over the tracker
  async function open(taskId: string) {
    setLoadingTask(taskId);
    try {
      const r = await api<{ task: Task }>(`/tasks/${taskId}`);
      setOpenTask(r.task);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't open that task.");
    } finally {
      setLoadingTask(null);
    }
  }
  async function refreshOpen() {
    if (!openTask) return;
    try { setOpenTask((await api<{ task: Task }>(`/tasks/${openTask.id}`)).task); } catch { /* it stays as it was */ }
  }
  if (error) return <div className="trk-card trk-empty">{error}</div>;
  if (!d) return <div className="trk-card"><Loader label="Loading…" /></div>;
  const p = d.profile, t = d.totals, s = d.score;
  const tasks = d.tasks.filter((x) => show === "all"
    || (show === "done" ? x.status === "done" : show === "open" ? x.status !== "done" : show === "late" ? x.late : x.sentBacks > 0));
  const att = ATT_WORDS.filter(([k]) => (t.attendance[k] ?? 0) > 0);
  const today = istToday();
  const words = periodWords(period);

  return (
    <>
      <section className="trk-card trk-profile" aria-label="Profile">
        <Ava name={p.name} image={p.imageUrl} size={56} />
        <div className="trk-pro-main">
          <h2>{p.name}{!p.active && <small className="trk-off">Switched off</small>}</h2>
          <span className="trk-pro-sub">{[p.designation || "Team member", p.code].filter(Boolean).join(" · ")}</span>
          <dl className="trk-facts">
            {p.leadName && <><dt>Team Lead</dt><dd>{p.leadName}</dd></>}
            {p.email && <><dt>Login</dt><dd>{p.email}{p.loginOn === false ? " (switched off)" : ""}</dd></>}
            {p.brands.length > 0 && <><dt>Brands</dt><dd>{p.brands.join(", ")}</dd></>}
            <dt>On Echo since</dt><dd>{dayWords(p.since)}</dd>
          </dl>
        </div>
      </section>

      <section className="trk-stats" aria-label={`${words} in numbers`}>
        <div className={"trk-stat " + pctTone(s?.pct ?? null)}><small>Goal{d.dates ? ` · ${monthWords(d.month).split(" ")[0]}` : ""}</small><b>{s?.pct == null ? "—" : `${Math.round(s.pct)}%`}</b><span>{s ? `${s.reached} of ${s.goalPoints} pts` : "No goal set"}</span></div>
        <div className="trk-stat"><small>Done</small><b>{t.done}</b><span>{t.points} pts</span></div>
        <div className={"trk-stat" + (t.late ? " low" : "")}><small>On time</small><b>{t.onTime}</b><span>{t.late ? `${t.late} late` : "none late"}</span></div>
        <div className={"trk-stat" + (t.sentBack ? " mid" : "")}><small>Sent back</small><b>{t.sentBack}</b><span>for rework</span></div>
        <div className="trk-stat"><small>Worked</small><b>{t.hoursWorked}h</b><span>{t.daysWorked} day{t.daysWorked === 1 ? "" : "s"}</span></div>
        {d.live && <div className={"trk-stat" + (d.tasks.some((x) => x.status !== "done" && x.due && x.due < today) ? " low" : "")}><small>Open now</small><b>{t.open}</b><span>on the board</span></div>}
      </section>

      {(s?.types.length || att.length || (s && (s.otherHours || s.creditHours))) ? (
        <section className="trk-card trk-side" aria-label="Goals and attendance">
          {s && s.types.length > 0 && (
            <div className="trk-goals">
              <span className="trk-h">Goals by type · {monthWords(d.month)}</span>
              {s.types.map((g) => {
                const pct = g.goal > 0 ? Math.min(100, (g.done / g.goal) * 100) : 100;
                return (
                  <div key={g.name} className="trk-goal">
                    <span className="trk-goal-n">{g.icon} {g.name}</span>
                    <span className="trk-bar"><i style={{ width: `${pct}%` }} /></span>
                    <span className="trk-goal-v">{g.done}{g.goal > 0 ? ` / ${g.goal}` : ""}</span>
                  </div>
                );
              })}
              {(s.otherHours > 0 || s.creditHours > 0) && (
                <span className="trk-note">{[s.otherHours > 0 ? `${s.otherHours}h of Other work` : "", s.creditHours > 0 ? `${s.creditHours}h of team goal credit` : ""].filter(Boolean).join(" · ")}</span>
              )}
            </div>
          )}
          {att.length > 0 && (
            <div className="trk-att">
              <span className="trk-h">Attendance · {words}</span>
              <div className="trk-chips">{att.map(([k, w]) => <span key={k} className={"trk-chip " + k}>{w} <b>{t.attendance[k]}</b></span>)}</div>
            </div>
          )}
        </section>
      ) : null}

      <section className="trk-card trk-tasks" aria-label="Task history">
        <div className="trk-tasks-head">
          <span className="trk-h">Tasks · {words}</span>
          <span className="trk-grow" />
          <div className="trk-seg" role="group" aria-label="Show">
            {(["all", "done", ...(d.live ? ["open"] : []), "late", "rework"] as const).map((k) => (
              <button key={k} type="button" className={show === k ? "on" : ""} onClick={() => setShow(k as typeof show)}>
                {k === "all" ? "All" : k === "done" ? "Done" : k === "open" ? "Open" : k === "late" ? "Late" : "Sent back"}
              </button>
            ))}
          </div>
        </div>
        {tasks.length === 0 ? (
          <div className="trk-empty">{show === "all" ? "No tasks in these dates." : "None here."}</div>
        ) : (
          <div className="trk-trows">
            <div className="trk-thead" aria-hidden="true"><span>Task</span><span>When</span><span>Review</span><span>Time</span><span /></div>
            {tasks.map((x) => (
              <button key={x.id} type="button" className={"trk-trow st-" + x.status + (openTask?.id === x.id ? " on" : "")} disabled={loadingTask === x.id} onClick={() => open(x.id)}>
                <span className="trk-tmain">
                  <b>{x.ref && <span className="trk-ref">{x.ref}</span>}{x.title}{x.jobs > 1 && <span className="trk-jobs">×{x.jobs}</span>}</b>
                  <small>{[x.typeName ? `${x.typeIcon ?? ""} ${x.typeName}`.trim() : null, x.brand, x.given ? "given" : "own"].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="trk-twhen">
                  {x.status === "done" ? <><b>{dayWords(x.completedAt)}</b><small>{x.due ? `due ${dayWords(x.due)}` : "no due date"}</small></>
                    : <><b>{x.due ? `Due ${dayWords(x.due)}` : "No due date"}</b><small>made {dayWords(x.createdAt)}</small></>}
                </span>
                {/* who approved it (or that they closed it themselves), and its trips back for rework */}
                <span className="trk-trev">
                  <b>{x.status === "done" ? (x.closedBySelf ? "Closed by themselves" : x.approvedBy ? `Approved by ${x.approvedBy}` : "Closed")
                    : x.status === "review" ? `Waiting for ${x.waitingFor ?? "review"}` : x.submissions > 0 ? "Back for rework" : "Not handed in yet"}</b>
                  <small className={x.sentBacks ? "mid" : ""}>{x.sentBacks > 0
                    ? `Sent back ${times(x.sentBacks)} · handed in ${times(Math.max(x.submissions, x.sentBacks))}`
                    : x.submissions > 0 ? `Handed in ${times(x.submissions)}, no rework` : x.status === "done" ? "No rework" : "—"}</small>
                </span>
                {/* the time it took, once done (its clock, never the pauses); open: the time it was given */}
                <span className="trk-ttime">{x.budgetHours == null ? <small>—</small>
                  : x.status === "done" ? <>{x.hoursUsed}h<small> of {x.budgetHours}h</small></>
                  : <small>{x.budgetHours}h set</small>}</span>
                <span className="trk-ttags">
                  {x.late && <i className="trk-tag bad">Late</i>}
                  <i className={"trk-tag st " + x.status}>{x.onHold && x.status === "in_progress" ? "On hold" : STATUS_WORDS[x.status]}</i>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite={active?.role !== "viewer"} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => { setOpenTask(null); load(); }}
          onChanged={() => { refreshOpen(); load(); }}
          onCreated={() => {}}
        />
      )}
    </>
  );
}
