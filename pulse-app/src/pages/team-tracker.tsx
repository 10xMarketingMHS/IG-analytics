import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { Loader } from "@/components/loader";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { clockTime } from "@/lib/time-format";
import "./team-tracker.css";

// Team tracker — for the Managers, Asst. Managers and Team Leads: their team
// (your level and below, as on the Task Board), each person's month at a
// glance; pick one for their profile, their month's numbers and every task:
// what they finished that month and, this month, what's open now. A task opens
// on the Task Board. Data: GET /team-tracker (server/src/routes/team-tracker.js).

type Person = {
  id: string; name: string; designation: string | null; imageUrl: string | null; code: string | null; rank: number; me: boolean;
  done: number; open: number; overdue: number; pct: number | null;
  today: "working" | "ended" | "not_started" | "leave" | "half_day"; startedAt: string | null;
};
type TrackTask = {
  id: string; ref: string | null; title: string; status: "todo" | "in_progress" | "review" | "done"; taskType: string; onHold: boolean; revision: number;
  due: string | null; completedAt: string | null; createdAt: string; typeName: string | null; typeIcon: string | null; brand: string | null;
  points: number | null; jobs: number; budgetHours: number | null; hoursUsed: number; deliveryLink: string | null; late: boolean; given: boolean;
};
type Detail = {
  month: string;
  profile: { id: string; name: string; designation: string | null; imageUrl: string | null; code: string | null; active: boolean; since: string;
    leadName: string | null; email: string | null; loginOn: boolean | null; brands: string[]; rank: number };
  score: { pct: number | null; goalPoints: number; reached: number; types: { name: string; icon: string | null; goal: number; done: number }[]; otherHours: number; creditHours: number } | null;
  totals: { done: number; points: number; late: number; onTime: number; sentBack: number; open: number; hoursWorked: number; daysWorked: number; attendance: Record<string, number> };
  tasks: TrackTask[];
};

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const monthWords = (m: string) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const dayWords = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
const TODAY_WORDS: Record<Person["today"], string> = { working: "Working", ended: "Day ended", not_started: "Not started", leave: "On leave", half_day: "Half day" };
const STATUS_WORDS: Record<TrackTask["status"], string> = { todo: "To do", in_progress: "In progress", review: "In review", done: "Done" };
const ATT_WORDS: [string, string][] = [["on_time", "On time"], ["late", "Late"], ["half_day", "Half day"], ["leave", "Leave"], ["absent", "Absent"], ["no_sod", "No plan"]];
const pctTone = (p: number | null) => (p == null ? "" : p >= 90 ? "good" : p >= 60 ? "mid" : "low");

function Ava({ name, image, size = 34 }: { name: string; image: string | null; size?: number }) {
  return image
    ? <img className="tt-ava" src={image} alt="" style={{ width: size, height: size }} />
    : <span className="tt-ava" style={{ width: size, height: size, background: gradFor(name), fontSize: size * 0.36 }}>{initialsOf(name)}</span>;
}

export function TeamTrackerPage() {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : thisMonth();
  const picked = params.get("p");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    api<{ people: Person[] }>(`/team-tracker?month=${month}`)
      .then((r) => { if (live) { setPeople(r.people); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : "Couldn't load your team."); });
    return () => { live = false; };
  }, [month]);
  const set = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || (p.designation ?? "").toLowerCase().includes(s) || (p.code ?? "").toLowerCase().includes(s));
  }, [people, q]);
  const current = month === thisMonth();

  if (error) return <section className="screen tt"><div className="tt-card tt-empty">{error}</div></section>;
  if (!people) return <section className="screen"><Loader label="Loading your team…" /></section>;
  return (
    <section className="screen tt">
      <div className="tt-top">
        <div className="tt-title">
          <h1>Team tracker</h1>
          <span>Your team, each person's month, and their task history. Pick a name.</span>
        </div>
        <span className="tt-grow" />
        <div className="tt-month" role="group" aria-label="Month">
          <button type="button" onClick={() => set({ month: shiftMonth(month, -1) })} aria-label="Month before">‹</button>
          <b>{monthWords(month)}</b>
          <button type="button" disabled={current} onClick={() => set({ month: shiftMonth(month, 1) === thisMonth() ? null : shiftMonth(month, 1) })} aria-label="Month after">›</button>
        </div>
      </div>

      <div className="tt-split">
        <aside className="tt-card tt-people" aria-label="Your team">
          <label className="tt-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name" aria-label="Search a name" />
          </label>
          <div className="tt-list">
            {shown.length === 0 && <div className="tt-empty">No one matches.</div>}
            {shown.map((p) => (
              <button key={p.id} type="button" className={"tt-person" + (picked === p.id ? " on" : "")} aria-pressed={picked === p.id} onClick={() => set({ p: p.id })}>
                <Ava name={p.name} image={p.imageUrl} />
                <span className="tt-pmain">
                  <b>{p.name}{p.me ? <small> · you</small> : null}</b>
                  <small>{p.designation || "Team member"}{current ? <> · <i className={"tt-day " + p.today}>{TODAY_WORDS[p.today]}{p.today === "working" && p.startedAt ? ` since ${clockTime(p.startedAt)}` : ""}</i></> : null}</small>
                </span>
                <span className="tt-pnums">
                  <span title="Done this month"><b>{p.done}</b> done</span>
                  {current && <span title="Open now" className={p.overdue ? "bad" : ""}>{p.open} open{p.overdue ? ` · ${p.overdue} late` : ""}</span>}
                </span>
                <span className={"tt-pct " + pctTone(p.pct)} title="Goal this month">{p.pct == null ? "—" : `${Math.round(p.pct)}%`}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="tt-detail">
          {picked ? <PersonView key={`${picked}:${month}`} id={picked} month={month} current={current} />
            : <div className="tt-card tt-empty tt-pick">Pick a name to see their profile and task history.</div>}
        </div>
      </div>
    </section>
  );
}

function PersonView({ id, month, current }: { id: string; month: string; current: boolean }) {
  const navigate = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<"all" | "done" | "open" | "late">("all");
  useEffect(() => {
    let live = true;
    api<Detail>(`/team-tracker/${id}?month=${month}`)
      .then((r) => { if (live) setD(r); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : "Couldn't load them."); });
    return () => { live = false; };
  }, [id, month]);
  if (error) return <div className="tt-card tt-empty">{error}</div>;
  if (!d) return <div className="tt-card"><Loader label="Loading…" /></div>;
  const p = d.profile, t = d.totals, s = d.score;
  const tasks = d.tasks.filter((x) => show === "all" || (show === "done" ? x.status === "done" : show === "open" ? x.status !== "done" : x.late));
  const att = ATT_WORDS.filter(([k]) => (t.attendance[k] ?? 0) > 0);
  const openTask = (taskId: string) => navigate("/tasks", { state: { openTask: taskId } });

  return (
    <>
      <section className="tt-card tt-profile" aria-label="Profile">
        <Ava name={p.name} image={p.imageUrl} size={56} />
        <div className="tt-pro-main">
          <h2>{p.name}{!p.active && <small className="tt-off">Switched off</small>}</h2>
          <span className="tt-pro-sub">{[p.designation || "Team member", p.code].filter(Boolean).join(" · ")}</span>
          <dl className="tt-facts">
            {p.leadName && <><dt>Team Lead</dt><dd>{p.leadName}</dd></>}
            {p.email && <><dt>Login</dt><dd>{p.email}{p.loginOn === false ? " (switched off)" : ""}</dd></>}
            {p.brands.length > 0 && <><dt>Brands</dt><dd>{p.brands.join(", ")}</dd></>}
            <dt>On Echo since</dt><dd>{dayWords(p.since)}</dd>
          </dl>
        </div>
      </section>

      <section className="tt-stats" aria-label={`${monthWords(d.month)} in numbers`}>
        <div className={"tt-stat " + pctTone(s?.pct ?? null)}><small>Goal</small><b>{s?.pct == null ? "—" : `${Math.round(s.pct)}%`}</b><span>{s ? `${s.reached} of ${s.goalPoints} pts` : "No goal set"}</span></div>
        <div className="tt-stat"><small>Done</small><b>{t.done}</b><span>{t.points} pts</span></div>
        <div className={"tt-stat" + (t.late ? " low" : "")}><small>On time</small><b>{t.onTime}</b><span>{t.late ? `${t.late} late` : "none late"}</span></div>
        <div className={"tt-stat" + (t.sentBack ? " mid" : "")}><small>Sent back</small><b>{t.sentBack}</b><span>for rework</span></div>
        <div className="tt-stat"><small>Worked</small><b>{t.hoursWorked}h</b><span>{t.daysWorked} day{t.daysWorked === 1 ? "" : "s"}</span></div>
        {current && <div className={"tt-stat" + (d.tasks.some((x) => x.status !== "done" && x.due && x.due < new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)) ? " low" : "")}><small>Open now</small><b>{t.open}</b><span>on the board</span></div>}
      </section>

      {(s?.types.length || att.length || (s && (s.otherHours || s.creditHours))) ? (
        <section className="tt-card tt-side" aria-label="Goals and attendance">
          {s && s.types.length > 0 && (
            <div className="tt-goals">
              <span className="tt-h">Goals by type</span>
              {s.types.map((g) => {
                const pct = g.goal > 0 ? Math.min(100, (g.done / g.goal) * 100) : 100;
                return (
                  <div key={g.name} className="tt-goal">
                    <span className="tt-goal-n">{g.icon} {g.name}</span>
                    <span className="tt-bar"><i style={{ width: `${pct}%` }} /></span>
                    <span className="tt-goal-v">{g.done}{g.goal > 0 ? ` / ${g.goal}` : ""}</span>
                  </div>
                );
              })}
              {(s.otherHours > 0 || s.creditHours > 0) && (
                <span className="tt-note">{[s.otherHours > 0 ? `${s.otherHours}h of Other work` : "", s.creditHours > 0 ? `${s.creditHours}h of team goal credit` : ""].filter(Boolean).join(" · ")}</span>
              )}
            </div>
          )}
          {att.length > 0 && (
            <div className="tt-att">
              <span className="tt-h">Attendance</span>
              <div className="tt-chips">{att.map(([k, w]) => <span key={k} className={"tt-chip " + k}>{w} <b>{t.attendance[k]}</b></span>)}</div>
            </div>
          )}
        </section>
      ) : null}

      <section className="tt-card tt-tasks" aria-label="Task history">
        <div className="tt-tasks-head">
          <span className="tt-h">Tasks · {monthWords(d.month)}</span>
          <span className="tt-grow" />
          <div className="tt-seg" role="group" aria-label="Show">
            {(["all", "done", ...(current ? ["open"] : []), "late"] as const).map((k) => (
              <button key={k} type="button" className={show === k ? "on" : ""} onClick={() => setShow(k as typeof show)}>
                {k === "all" ? "All" : k === "done" ? "Done" : k === "open" ? "Open" : "Late"}
              </button>
            ))}
          </div>
        </div>
        {tasks.length === 0 ? (
          <div className="tt-empty">{show === "all" ? "No tasks this month." : "None here."}</div>
        ) : (
          <div className="tt-trows">
            {tasks.map((x) => (
              <button key={x.id} type="button" className={"tt-trow st-" + x.status} onClick={() => openTask(x.id)}>
                <span className="tt-tmain">
                  <b>{x.ref && <span className="tt-ref">{x.ref}</span>}{x.title}{x.jobs > 1 && <span className="tt-jobs">×{x.jobs}</span>}</b>
                  <small>{[x.typeName ? `${x.typeIcon ?? ""} ${x.typeName}`.trim() : null, x.brand, x.given ? "given" : "own"].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="tt-twhen">
                  {x.status === "done" ? <><b>{dayWords(x.completedAt)}</b><small>{x.due ? `due ${dayWords(x.due)}` : "no due date"}</small></>
                    : <><b>{x.due ? `Due ${dayWords(x.due)}` : "No due date"}</b><small>made {dayWords(x.createdAt)}</small></>}
                </span>
                {/* the time it took, once done (its clock, never the pauses); open: the time it was given */}
                <span className="tt-ttime">{x.budgetHours == null ? <small>—</small>
                  : x.status === "done" ? <>{x.hoursUsed}h<small> of {x.budgetHours}h</small></>
                  : <small>{x.budgetHours}h set</small>}</span>
                <span className="tt-ttags">
                  {x.late && <i className="tt-tag bad">Late</i>}
                  {x.revision > 0 && <i className="tt-tag mid" title="Sent back for rework">Rev {x.revision + 1}</i>}
                  <i className={"tt-tag st " + x.status}>{x.onHold && x.status === "in_progress" ? "On hold" : STATUS_WORDS[x.status]}</i>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
