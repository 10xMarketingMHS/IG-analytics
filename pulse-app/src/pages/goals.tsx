import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, API_BASE, getActiveWorkspaceId, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useAuth } from "@/lib/auth-context";
import { useEditors } from "@/lib/use-editors";
import { useTasks } from "@/lib/use-tasks";
import { useResource } from "@/lib/use-resource";
import { gradFor } from "@/lib/editor-visuals";
import { ymd } from "@/lib/task-points";
import { DISCIPLINE_CRITERIA, goalBreakdown, type Ratings } from "@/lib/goal-points";
import {
  achievement, bandOf, currentPeriod, doneByType, goalLines, monthName, pctText, periodBounds, periodLabel, tenths,
  type GoalLine, type PerfRow, type Period,
} from "@/lib/goal-periods";
import type { Editor } from "@/lib/types";
import { OrgGoals } from "@/pages/goals-org";
import { SetGoals } from "@/pages/goals-set";
import "./goals.css";

// Goals (Pulse Redesign v5): Team goals — each person's monthly goals by
// content type against what they finished, for a review period or the month
// (anyone else sees only their own: My goals, read-only);
// Org goals — the admin-entered goals; Set goals — each person's job counts for
// the month, checked against their hours; and Discipline — the five ratings
// that make up 20% of each person's score.

type Tab = "team" | "org" | "set" | "disc";
const sv = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  team: sv(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6a6.5 6.5 0 0 1 3.5 5.4" /></>),
  flag: sv(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>),
  verified: sv(<><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>),
  tune: sv(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>),
  download: sv(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, 15),
  group: sv(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /></>, 14),
  edit: sv(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, 14),
};
const STAR = (on: boolean) => (
  <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={on ? 0 : 1.6} strokeLinejoin="round">
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
  </svg>
);

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
function Face({ editor, size = "md" }: { editor: Pick<Editor, "name" | "image_url">; size?: "sm" | "md" | "lg" }) {
  return editor.image_url
    ? <img className={"gl-ava " + size} src={editor.image_url} alt="" />
    : <span className={"gl-ava " + size} style={{ background: gradFor(editor.name) }}>{initials(editor.name)}</span>;
}

export function GoalsPage() {
  const { isAdmin, hasPermission } = useWorkspaces();
  const [params, setParams] = useSearchParams();
  const canDisc = isAdmin || hasPermission("discipline");
  // Set goals is for whoever sets them; everyone else has My goals.
  const canSet = hasPermission("edit_goals");
  // Everyone but admins and the goal grants sees only their own goals.
  const selfOnly = !isAdmin && !hasPermission("edit_goals") && !hasPermission("discipline");
  const raw = params.get("tab");
  const tab: Tab = raw === "org" ? "org" : raw === "set" && canSet ? "set" : raw === "disc" && canDisc ? "disc" : "team";
  const setTab = (t: Tab) => setParams(t === "team" ? {} : { tab: t }, { replace: true });
  const thisMonth = ymd(new Date()).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const { data: monthsData } = useResource<{ months: string[] }>("/goals/months");
  const months = useMemo(() => [...new Set([thisMonth, ...(monthsData?.months ?? [])])].sort().reverse(), [monthsData, thisMonth]);

  const TABS: { k: Tab; l: string; icon: ReactNode; admin?: boolean; show: boolean }[] = [
    { k: "team", l: selfOnly ? "My goals" : "Team goals", icon: IC.team, show: true },
    { k: "org", l: "Org goals", icon: IC.flag, show: isAdmin },
    { k: "set", l: "Set goals", icon: IC.tune, admin: true, show: canSet },
    { k: "disc", l: "Discipline", icon: IC.verified, admin: true, show: canDisc },
  ];
  return (
    <section className="screen gl">
      <div className="gl-tabs">
        {TABS.filter((t) => t.show).map((t) => (
          <button key={t.k} type="button" className={tab === t.k ? "on" : ""} onClick={() => setTab(t.k)} aria-pressed={tab === t.k}>
            {t.icon}{t.l}{t.admin && <span className="gl-admin">ADMIN</span>}
          </button>
        ))}
        <span className="gl-grow" />
        {tab !== "org" && tab !== "set" && (
          <select className="gl-select gl-month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        )}
      </div>
      {tab === "team" && <TeamGoals month={month} isCurrent={month === thisMonth} focusId={params.get("editor")} selfOnly={selfOnly} />}
      {tab === "org" && <OrgGoals />}
      {tab === "set" && <SetGoals />}
      {tab === "disc" && <Discipline month={month} />}
    </section>
  );
}

type Person = { editor: Editor; rows: PerfRow[]; lines: GoalLine[]; target: number; done: number; x: number; missed: number };
// The month's time away from the goal (server/src/goal-score.js): approved leave,
// and Other work — tasks given to them outside their goals, at the time they took.
type OtherTask = { taskId: string | null; title: string | null; typeName: string | null; requestedBy: string | null; hours: number; completedAt: string | null };
type TimeOff = { leaveDays?: number; otherHours?: number; otherWork?: OtherTask[]; monthHours?: number };

// Time away from the goal this month: leave and Other work, how much it took
// off the goal, and the Other tasks themselves (who asked, how long each took).
function TimeAway({ off, rows }: { off?: TimeOff; rows: PerfRow[] }) {
  const other = off?.otherWork ?? [];
  if (!off || (!(off.otherHours ?? 0) && !(off.leaveDays ?? 0))) return null;
  const set = rows.find((r) => r.goalJC > 0);
  const left = set && set.goalAdjusted != null ? set.goalAdjusted / set.goalJC : null;
  const hrs = (h: number) => `${Math.round(h * 10) / 10}h`;
  const parts = [
    (off.otherHours ?? 0) > 0 && `${hrs(off.otherHours!)} of Other work`,
    (off.leaveDays ?? 0) > 0 && `${off.leaveDays} day${off.leaveDays === 1 ? "" : "s"} of leave`,
  ].filter(Boolean).join(" and ");
  return (
    <div className="gl-away">
      <span className="gl-awayline">
        <b>Time away from the goal: {parts}</b>
        {left != null && <span>The goal counts {Math.round(left * 100)}% of what was set{off.monthHours ? ` (out of ${hrs(off.monthHours)} this month)` : ""}, so it's still fair.</span>}
      </span>
      {other.length > 0 && (
        <div className="gl-awaylist">
          {other.map((t, n) => (
            <span key={t.taskId ?? n} className="gl-awayrow">
              <b>{t.title ?? "A task"}</b>
              <span>{[t.typeName, t.requestedBy ? `asked by ${t.requestedBy}` : null, t.completedAt ? new Date(t.completedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : null].filter(Boolean).join(" · ")}</span>
              <em>{hrs(t.hours)}</em>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamGoals({ month, isCurrent, focusId, selfOnly }: { month: string; isCurrent: boolean; focusId: string | null; selfOnly: boolean }) {
  const { isAdmin, hasPermission } = useWorkspaces();
  const { user } = useAuth();
  const { editors } = useEditors();
  const { tasks } = useTasks();
  const navigate = useNavigate();
  const [per, setPer] = useState<Period>(() => (isCurrent ? currentPeriod() : "m"));
  useEffect(() => { setPer(isCurrent ? currentPeriod() : "m"); }, [month, isCurrent]);
  const [view, setView] = useState<"people" | "types">("people");
  const [selId, setSelId] = useState<string | null>(focusId);
  const [perf, setPerf] = useState<Record<string, PerfRow[]> | null>(null);
  const [timeOff, setTimeOff] = useState<Record<string, TimeOff>>({});
  const [exporting, setExporting] = useState(false);

  // Each person's goals and the month's done counts, in one request — only
  // your own unless you oversee the team.
  const active = useMemo(
    () => (editors ?? []).filter((e) => e.active && (!selfOnly || e.id === user?.editorId)),
    [editors, selfOnly, user?.editorId],
  );
  useEffect(() => {
    if (!active.length) { if (editors) setPerf({}); return; }
    let live = true;
    setPerf(null);
    api<{ people: Record<string, { rows: PerfRow[] } & TimeOff> }>(`/goals/performance-all?month=${month}-01`)
      .then((d) => {
        if (!live) return;
        setPerf(Object.fromEntries(active.map((e) => [e.id, d.people[e.id]?.rows ?? []])));
        setTimeOff(Object.fromEntries(Object.entries(d.people).map(([id, p]) => [id, { leaveDays: p.leaveDays, otherHours: p.otherHours, otherWork: p.otherWork, monthHours: p.monthHours }])));
      })
      .catch(() => { if (live) setPerf(Object.fromEntries(active.map((e) => [e.id, [] as PerfRow[]]))); });
    return () => { live = false; };
  }, [active, month, editors]);

  const [from, to] = periodBounds(month, per);
  const people = useMemo((): Person[] => {
    if (!perf) return [];
    return active
      .filter((e) => (perf[e.id] ?? []).length > 0)
      .map((e) => {
        const rows = perf[e.id];
        const lines = goalLines(rows, per, per === "m" ? undefined : doneByType(tasks ?? [], e.id, from, to));
        const a = achievement(lines);
        return { editor: e, rows, lines, target: a.target, done: a.done, x: a.x, missed: a.missed };
      })
      .filter((p) => p.target > 0);
  }, [perf, active, per, tasks, from, to]);
  const noGoals = perf ? active.filter((e) => !(perf[e.id] ?? []).length) : [];

  const sorted = [...people].sort((a, b) => b.x - a.x || a.editor.name.localeCompare(b.editor.name));
  const sel = people.find((p) => p.editor.id === selId) ?? [...people].sort((a, b) => a.x - b.x)[0] ?? null;
  const TT = tenths(people.reduce((s, p) => s + p.target, 0)), TD = tenths(people.reduce((s, p) => s + p.done, 0));
  const allLines = people.reduce((s, p) => s + p.lines.length, 0), missed = people.reduce((s, p) => s + p.missed, 0);
  const label = periodLabel(month, per);
  const kpis = [
    { l: selfOnly ? "Your achievement" : "Team achievement", v: TT ? pctText(TD / TT) : "–", s: label, tone: TT ? bandOf(TD / TT).tone : "" },
    { l: "Jobs done", v: String(TD), s: `of ${TT} targeted`, tone: "" },
    { l: "Goals not achieved", v: String(missed), s: `of ${allLines} goals`, tone: missed ? "bad" : "good" },
    ...(selfOnly ? [] : [{ l: "People at target", v: String(people.filter((p) => p.x >= 1).length), s: `of ${people.length} people`, tone: "" }]),
  ];

  // Where the gaps are: each goal type across everyone, weakest first.
  const types = useMemo(() => {
    const m = new Map<string, { name: string; t: number; d: number; short: Editor[] }>();
    for (const p of people) for (const l of p.lines) {
      const a = m.get(l.id) ?? { name: l.name, t: 0, d: 0, short: [] };
      a.t += l.target; a.d += Math.min(l.done, l.target);
      if (l.done < l.target) a.short.push(p.editor);
      m.set(l.id, a);
    }
    return [...m.values()].map((a) => ({ ...a, t: tenths(a.t), d: tenths(a.d), x: a.t ? a.d / a.t : 1 })).sort((a, b) => a.x - b.x);
  }, [people]);

  async function onExport() {
    setExporting(true);
    try {
      const ws = getActiveWorkspaceId();
      const res = await fetch(`${API_BASE}/goals/export?month=${month}`, { credentials: "include", headers: ws ? { "X-Workspace-Id": ws } : {} });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `goal-setting-${month}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error("Couldn't create the report.");
    } finally {
      setExporting(false);
    }
  }

  const PERIODS: [Period, string][] = [["h1", `Review 1 · 1–15`], ["h2", `Review 2 · 16–${periodBounds(month, "h2")[1].slice(8)}`], ["m", "Full month"]];
  return (
    <div className="gl-stack">
      <div className="gl-bar">
        <div className="gl-seg" role="group" aria-label="Period">
          {PERIODS.map(([k, l]) => <button key={k} type="button" className={per === k ? "on" : ""} onClick={() => setPer(k)}>{l}</button>)}
        </div>
        {!selfOnly && (
          <div className="gl-seg" role="group" aria-label="View">
            <button type="button" className={view === "people" ? "on" : ""} onClick={() => setView("people")}>People</button>
            <button type="button" className={view === "types" ? "on" : ""} onClick={() => setView("types")}>Goal types</button>
          </div>
        )}
        <span className="gl-hint">{selfOnly ? "Set by your admin · counts come from your approved tasks" : "Counts come from approved tasks, by content type"}</span>
        <span className="gl-grow" />
        {hasPermission("edit_goals") && <Link to="/goals-board?tab=set" className="gl-btn">{IC.edit}Set goals</Link>}
        {isAdmin && (
          <button type="button" className="gl-btn pri" onClick={onExport} disabled={exporting} title={`Download ${monthName(month)}'s goals and performance as an Excel file`}>
            {IC.download}{exporting ? "Preparing…" : "Excel report"}
          </button>
        )}
      </div>

      {perf === null ? (
        <div className="gl-card gl-empty">Loading goals…</div>
      ) : selfOnly && !user?.editorId ? (
        <div className="gl-card gl-empty">Your login isn't linked to a team member yet, so there are no goals to show. Ask an admin to link you on Team · Roster.</div>
      ) : people.length === 0 ? (
        <div className="gl-card gl-empty">
          {selfOnly ? `No goals set for you for ${per === "m" ? monthName(month) : label} yet.` : <>No goals set for {per === "m" ? monthName(month) : label} yet. <Link to="/goals-board?tab=set">Set them in Set goals</Link>.</>}
        </div>
      ) : (
        <>
          <div className="gl-kpis">
            {kpis.map((k) => (
              <div key={k.l}><span>{k.l}</span><span><b className={k.tone}>{k.v}</b><em>{k.s}</em></span></div>
            ))}
          </div>

          {view === "people" ? (
            <div className={"gl-row" + (selfOnly ? " self" : "")}>
              {!selfOnly && (
              <section className="gl-card gl-people">
                <div className="gl-sechd">
                  <b>By person</b><span className="gl-grow" />
                  <span className="gl-key good"><i />80%+</span><span className="gl-key warn"><i />50–79%</span><span className="gl-key bad"><i />under 50%</span>
                </div>
                {sorted.map((p) => {
                  const b = bandOf(p.x), on = sel?.editor.id === p.editor.id;
                  return (
                    <button key={p.editor.id} type="button" className={"gl-person" + (on ? " on" : "")} onClick={() => setSelId(p.editor.id)} aria-pressed={on}>
                      <Face editor={p.editor} size="sm" />
                      <span className="gl-pmain">
                        <span><b>{p.editor.name}</b><em>{p.missed ? `${p.missed} to discuss` : "all met"}</em></span>
                        <span className="gl-track sm"><span className={"gl-fill " + b.tone} style={{ width: `${Math.min(100, p.x * 100)}%` }} /></span>
                      </span>
                      <span className="gl-ppct"><b className={b.tone}>{pctText(p.x)}</b><em>{p.done} / {p.target}</em></span>
                    </button>
                  );
                })}
                {noGoals.length > 0 && (
                  <p className="gl-nogoal">{noGoals.length === 1 ? `${noGoals[0].name} has` : `${noGoals.length} people have`} no goals for {monthName(month, "short")}. <Link to="/goals-board?tab=set">Set them</Link>.</p>
                )}
              </section>
              )}

              {sel && (() => {
                const b = bandOf(sel.x);
                const lines = [...sel.lines].sort((a, z) => a.done / a.target - z.done / z.target);
                return (
                  <section className="gl-card gl-detail">
                    <div className="gl-dhead">
                      <Face editor={sel.editor} size="lg" />
                      <span className="gl-dwho"><b>{sel.editor.name}</b><span>{sel.editor.designation || "Team member"} · {label}</span></span>
                      <span className="gl-grow" />
                      {isAdmin && <button type="button" className="gl-btn sm" onClick={() => navigate("/my-team", { state: { editorId: sel.editor.id } })}>{IC.group}View in Team</button>}
                      <span className="gl-dpct"><b className={b.tone}>{pctText(sel.x)}</b><em>{sel.done} of {sel.target} jobs done</em></span>
                      <span className={"gl-tag " + b.tone}>{b.label}</span>
                    </div>
                    <div className="gl-monthgoal">
                      <span>{monthName(month, "short")} goal</span>
                      {sel.rows.map((r) => <span key={r.contentFormatId} className="gl-mchip">{r.name}<b>{r.goalJC}</b></span>)}
                    </div>
                    <TimeAway off={timeOff[sel.editor.id]} rows={sel.rows} />
                    <div className="gl-tablewrap">
                      <div className="gl-table">
                        <div className="gl-th"><span>Goal</span><span className="num">Month</span><span className="num">Target</span><span className="num">Done</span><span className="num">Pending</span><span>Progress</span><span>Status</span></div>
                        {lines.map((l) => {
                          const x = l.target ? l.done / l.target : 1, ok = l.done >= l.target;
                          const tone = ok ? "good" : x >= 0.5 ? "warn" : "bad";
                          return (
                            <div key={l.id} className="gl-tr">
                              <b>{l.name}</b><span className="num gl-muted">{l.month}</span><span className="num">{l.target}</span><b className="num">{l.done}</b>
                              <span className={"num " + (ok ? "gl-muted" : "bad")}>{tenths(Math.max(0, l.target - l.done))}</span>
                              <span className="gl-prog"><span className="gl-track sm"><span className={"gl-fill " + tone} style={{ width: `${Math.min(100, x * 100)}%` }} /></span><b className={tone}>{pctText(x)}</b></span>
                              <span><span className={"gl-tag " + (ok ? "good" : "bad")}>{ok ? "Achieved" : "Not achieved"}</span></span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                );
              })()}
            </div>
          ) : (
            <section className="gl-card gl-types">
              <div className="gl-sechd"><b>Where the gaps are</b><span className="gl-hint">By goal type, weakest first · each person counted only up to their own target</span></div>
              <div className="gl-tablewrap">
                <div className="gl-table types">
                  <div className="gl-th"><span>Goal type</span><span>Achieved</span><span className="num">Done</span><span className="num">Pending</span><span>People short</span></div>
                  {types.map((a) => {
                    const tone = a.x >= 1 ? "good" : a.x >= 0.5 ? "warn" : "bad";
                    return (
                      <div key={a.name} className="gl-tr">
                        <b>{a.name}</b>
                        <span className="gl-prog"><span className="gl-track"><span className={"gl-fill " + tone} style={{ width: `${Math.min(100, a.x * 100)}%` }} /></span><b className={tone}>{pctText(a.x)}</b></span>
                        <span className="num">{a.d} / {a.t}</span>
                        <span className={"num " + (a.t > a.d ? "bad" : "gl-muted")}>{tenths(a.t - a.d)}</span>
                        <span className="gl-short">
                          {a.short.slice(0, 5).map((e) => <span key={e.id} title={e.name}><Face editor={e} size="sm" /></span>)}
                          <em>{a.short.length ? `${a.short.length} short` : "All met"}</em>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

type DiscEditor = {
  editorId: string; editorName: string;
  // per type: the goal after approved leave, jobs done, jobs that count (server/src/goal-score.js)
  rows: { goalJC: number; actualJC: number; countedJC?: number; points: number }[];
  coveredPoints?: number; leaveDays?: number;
  ratings: Ratings; note: string | null; updatedAt: string | null; attendancePenalty?: number;
};

function Discipline({ month }: { month: string }) {
  // the bands Management Performance labels people by (Settings › Performance bands)
  const { data: bands } = useResource<{ epiMinPct: number; mpiMinPct: number }>("/management-performance/thresholds");
  const epi = bands?.epiMinPct ?? 85, mpi = bands?.mpiMinPct ?? 75;
  const { editors } = useEditors();
  const [data, setData] = useState<DiscEditor[] | null>(null);
  const [draft, setDraft] = useState<Record<string, Ratings>>({});
  const [saving, setSaving] = useState(false);
  const load = () => {
    setData(null);
    api<{ editors: DiscEditor[] }>(`/goals/discipline?month=${month}-01`)
      .then((d) => { setData(d.editors); setDraft({}); })
      .catch(() => setData([]));
  };
  useEffect(load, [month]);

  const dirty = Object.keys(draft);
  const ratingsOf = (e: DiscEditor): Ratings => ({ ...e.ratings, ...(draft[e.editorId] ?? {}) });
  function rate(e: DiscEditor, key: (typeof DISCIPLINE_CRITERIA)[number]["key"], n: number) {
    const cur = ratingsOf(e)[key];
    setDraft((d) => ({ ...d, [e.editorId]: { ...ratingsOf(e), [key]: cur === n ? null : n } }));
  }
  async function save() {
    if (!data || !dirty.length) return;
    setSaving(true);
    try {
      // Each entry carries its note back: saving replaces the whole row.
      const entries = data.filter((e) => draft[e.editorId]).map((e) => ({ editorId: e.editorId, ratings: ratingsOf(e), note: e.note }));
      await api("/goals/discipline", { method: "PUT", body: JSON.stringify({ month: `${month}-01`, entries }) });
      toast.success(`Ratings saved for ${entries.length} ${entries.length === 1 ? "person" : "people"}.`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save the ratings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="gl-card gl-disc">
      <div className="gl-sechd">
        <b>Discipline · {monthName(month)}</b>
        <span className="gl-hint">20% of each person's score. Unrated criteria count as full marks; tap a star again to clear it.</span>
        <span className="gl-grow" />
        <button type="button" className="gl-btn pri" onClick={save} disabled={saving || !dirty.length}>
          {saving ? "Saving…" : dirty.length ? `Save ratings (${dirty.length})` : "Save ratings"}
        </button>
      </div>
      {data === null ? <div className="gl-empty">Loading…</div> : data.length === 0 ? <div className="gl-empty">No team members to rate.</div> : (
        <div className="gl-tablewrap">
          <div className="gl-table disc">
            <div className="gl-th">
              <span>Person</span>{DISCIPLINE_CRITERIA.map((c) => <span key={c.key}>{c.label}</span>)}<span className="num">Disc.</span><span className="num">Overall</span><span>Status</span>
            </div>
            {data.map((e) => {
              const r = ratingsOf(e);
              const ed = editors?.find((x) => x.id === e.editorId);
              const bd = goalBreakdown(e.rows, r, e.attendancePenalty ?? 0, e.coveredPoints ?? 0);
              const rated = DISCIPLINE_CRITERIA.some((c) => r[c.key] != null);
              const disc = bd ? Math.round((bd.discipline / bd.total) * 100) : Math.round((DISCIPLINE_CRITERIA.reduce((s, c) => s + (r[c.key] ?? 5), 0) / 25) * 20);
              const overall = bd ? Math.round((bd.overall / bd.total) * 100) : null;
              const st = !rated ? { l: "Not rated yet", t: "" } : overall == null ? { l: "No goals", t: "" } : overall >= epi ? { l: "Excellent", t: "good" } : overall >= mpi ? { l: "On track", t: "ac" } : { l: "Needs support", t: "warn" };
              return (
                <div key={e.editorId} className={"gl-tr" + (draft[e.editorId] ? " dirty" : "")}>
                  <span className="gl-who"><Face editor={ed ?? { name: e.editorName, image_url: null }} size="sm" /><span><b>{e.editorName}</b><em>{ed?.designation || ""}</em></span></span>
                  {DISCIPLINE_CRITERIA.map((c) => (
                    <span key={c.key} className="gl-stars" role="radiogroup" aria-label={`${c.label} for ${e.editorName}`}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} type="button" role="radio" aria-checked={r[c.key] === n} aria-label={`${n} of 5`}
                          className={(r[c.key] ?? 0) >= n ? "on" : ""} onClick={() => rate(e, c.key, n)}>{STAR((r[c.key] ?? 0) >= n)}</button>
                      ))}
                    </span>
                  ))}
                  <b className="num" title={e.attendancePenalty ? `Includes −${e.attendancePenalty} attendance pt${e.attendancePenalty === 1 ? "" : "s"} (late, absent)` : undefined}>{disc}/20</b>
                  <b className="num lg">{overall ?? "–"}</b>
                  <span>{<span className={"gl-tag " + st.t}>{st.l}</span>}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
