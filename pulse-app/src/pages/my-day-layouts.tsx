import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { compactNum } from "@/lib/date-range";
import { formatScore } from "@/lib/score";
import { daysBetween } from "@/lib/task-points";
import { breakOffsetMs, fmtWait, reviewWaitMs, SLOW_REVIEW_MS } from "@/lib/task-timing";
import { Modal } from "@/components/modal";
import { classifyWorkload, fmtCloseIn, fmtHours, nineAmTomorrow, officeCloseToday } from "@/pages/tasks";
import type { Post, Task } from "@/lib/types";
import "./my-day.css";

// Everything on My Day under the hero banner, in three layouts the viewer picks
// between (remembered in this browser): Focus (what needs you, most urgent
// first), Dashboard (counts with trends, charts) and Me & Team (your work beside
// team oversight). home.tsx works the numbers out once and hands them here as
// MyDayData; the layouts only arrange the same sections differently.

type RankWindow = { points: number; completed: number; rank: number | null; totalRanked: number; counted: boolean };

export type MyDayData = {
  loading: boolean;
  today: string;
  nowMs: number;
  isAdmin: boolean;
  // Team (an admin's whole-team numbers) or the viewer's own.
  teamScope: boolean;
  openCount: number;
  // Reviews this viewer can resolve right now.
  waitingOnYou: number;
  // Open tasks in scope — the Dashboard's task table.
  scopeTasks: Task[];
  series: { overdue: number[]; dueToday: number[]; onTime: (number | null)[] };
  onTime: { pct: number | null; finished: number };
  avgReviewWait: number;
  oldestReviewWait: number;
  workingDaysLeft: number;
  // On the team roster — without that there's nothing personal to show.
  linked: boolean;
  // The one line shown when the page can't be personal.
  hint: string | null;
  counts: { overdue: number; dueToday: number; inReview: number; awaitingMetrics: number };
  countNotes: { overdue: string; dueToday: string; inReview: string; awaitingMetrics: string };
  myTasks: Task[];
  completedToday: number;
  pointsToday: number;
  focusSeconds: number;
  dailyGoalPct: number | null;
  clockedInSince: string | null;
  week: RankWindow | null;
  month: RankWindow | null;
  weekDays: { label: string; date: string; points: number; isToday: boolean; future: boolean }[] | null;
  canReview: boolean;
  reviewQueue: Task[];
  pipeline: Record<string, number>;
  analytics: { views: number; posts: number; engRate: number | null; top: (Post & { channel_name?: string }) | undefined };
  viewsByDay: { day: number; views: number }[];
};

type Layout = "focus" | "dashboard" | "team";
const LAYOUTS: { key: Layout; label: string }[] = [
  { key: "focus", label: "Focus" },
  { key: "dashboard", label: "Dashboard" },
  { key: "team", label: "Me & Team" },
];
const LAYOUT_KEY = "pulse-myday-layout";

function readLayout(): Layout {
  try {
    const v = window.localStorage.getItem(LAYOUT_KEY);
    if (v === "focus" || v === "dashboard" || v === "team") return v;
    if (v === "lanes") return "team"; // the earlier name for Me & Team
  } catch { /* private window — fall back */ }
  return "focus";
}

// The editing pipeline's stages, each in its status colour.
const STAGES: { key: string; label: string; tone: string }[] = [
  { key: "not_started", label: "Not started", tone: "todo" },
  { key: "in_progress", label: "In progress", tone: "prog" },
  { key: "in_review", label: "In review", tone: "rev" },
  { key: "pending", label: "Pending", tone: "pend" },
  { key: "completed", label: "Completed", tone: "done" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hoursMins(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
// 63 minutes → "1:03"
function clock(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

// The number people know a task by: its brand's SID/AID/SVID/PID, else the TID.
export function taskRef(t: Task) {
  return t.sid || t.ad_id?.replace(/^AdID/i, "AID") || t.svid || t.pid || t.tid || "";
}

// Solid colours dark enough for white initials, one per person by name.
const AVATAR_COLORS = ["#7c3aed", "#2563eb", "#0e7490", "#047857", "#b45309", "#be185d", "#4f46e5", "#0f766e", "#a21caf", "#c2410c"];
function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0]?.[0] ?? "?")).toUpperCase();
}
export function Initials({ name, size = 30, round }: { name: string; size?: number; round?: boolean }) {
  return (
    <span className="md-ini" aria-hidden="true"
      style={{ width: size, height: size, background: avatarColor(name), borderRadius: round ? "50%" : Math.round(size * 0.3), fontSize: Math.round(size * 0.36) }}>
      {initials(name)}
    </span>
  );
}

type Due = { label: string; tone: "bad" | "warn" | "quiet" };
export function dueOf(t: Task, today: string): Due {
  if (!t.due_date) return { label: "No due date", tone: "quiet" };
  const d = daysBetween(today, t.due_date);
  if (d < 0) return { label: "Overdue", tone: "bad" };
  if (d === 0) return { label: "Today", tone: "warn" };
  if (d === 1) return { label: "Tomorrow", tone: "quiet" };
  return { label: new Date(t.due_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), tone: "quiet" };
}

// Where a task stands, in words: "Sent back for changes", "In progress · 1:03 of 1.5h".
export function noteOf(t: Task, nowMs: number) {
  if (t.pending_note && t.status !== "done") return "Sent back for changes";
  if (t.status === "in_progress") {
    if (t.on_hold) return "On hold";
    if (t.budget_started_at && t.budget_hours != null) {
      const used = nowMs - new Date(t.budget_started_at).getTime() - breakOffsetMs(t, nowMs);
      return `In progress · ${clock(used)} of ${fmtHours(Number(t.budget_hours))}h`;
    }
    return "In progress";
  }
  if (t.status === "review") return "Waiting on review";
  return t.accepted ? "Not started" : "Waiting for you to accept";
}

type Pill = { label: string; tone: string };
function pillOf(t: Task): Pill {
  if (t.pending_note && t.status !== "done" && t.status !== "review") return { label: "Sent back", tone: "bad" };
  return ({
    todo: { label: "To do", tone: "todo" },
    in_progress: { label: "In progress", tone: "prog" },
    review: { label: "In review", tone: "rev" },
    done: { label: "Completed", tone: "done" },
  } as Record<string, Pill>)[t.status] ?? { label: t.status, tone: "todo" };
}

type Group = { key: "overdue" | "today" | "later"; label: string; tasks: Task[] };
function groupTasks(tasks: Task[], today: string): Group[] {
  const overdue = tasks.filter((t) => t.due_date != null && t.due_date < today);
  const due = tasks.filter((t) => t.due_date === today);
  const later = tasks.filter((t) => t.due_date == null || t.due_date > today);
  return [
    { key: "overdue" as const, label: "Overdue", tasks: overdue },
    { key: "today" as const, label: "Due today", tasks: due },
    { key: "later" as const, label: "Later", tasks: later },
  ].filter((g) => g.tasks.length > 0);
}

// The monthly task goal (real tracked task counts — see management-performance).
type MyGoal = { linked: boolean; hasGoal?: boolean; goalTargetNumber: number; achievedNumber: number };
export function useMyGoal(enabled: boolean) {
  const [goal, setGoal] = useState<MyGoal | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api<MyGoal>("/management-performance/me").then(setGoal).catch(() => setGoal(null));
  }, [enabled]);
  if (!goal || !goal.linked || !goal.hasGoal || goal.goalTargetNumber <= 0) return null;
  return {
    done: goal.achievedNumber,
    target: goal.goalTargetNumber,
    pct: Math.round((goal.achievedNumber / goal.goalTargetNumber) * 100),
    toGo: Math.max(0, goal.goalTargetNumber - goal.achievedNumber),
  };
}
type Goal = ReturnType<typeof useMyGoal>;
export const monthName = () => new Date().toLocaleDateString("en-GB", { month: "long" });

// ---------------------------------------------------------------------------
// Starting a task — the Task Board's own rules (accept first if it isn't yours
// yet; a timed task checks the day's workload and office hours, and can start
// now or at 9 AM tomorrow; a task sent back shows its note before resuming).
// ---------------------------------------------------------------------------

type StartPrompt =
  | { kind: "workload"; task: Task; total: number; tier: 1 | 2 }
  | { kind: "hours"; task: Task; closeIn: string; alreadyClosed: boolean }
  | { kind: "rework"; task: Task };

function actionOf(t: Task): "accept" | "start" | "open" {
  if (!t.accepted && (t.status === "todo" || t.status === "in_progress")) return "accept";
  if (t.status === "todo") return "start";
  return "open";
}

export function useStartFlow(myTasks: Task[], onChanged: () => Promise<unknown>) {
  const [prompt, setPrompt] = useState<StartPrompt | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(t: Task, call: () => Promise<unknown>, done: string) {
    setBusyId(t.id);
    try {
      await call();
      toast.success(done);
      setPrompt(null);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't update that task.");
    } finally {
      setBusyId(null);
    }
  }

  const begin = (t: Task, startAt: Date) => {
    const later = startAt.getTime() > Date.now();
    return t.accepted
      ? run(t, () => api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress", startAt: startAt.toISOString() }) }),
        later ? "Started. Its timer begins as scheduled." : t.budget_hours != null ? "Started. Timer running." : "Started.")
      : run(t, () => api(`/tasks/${t.id}/accept`, { method: "POST", body: JSON.stringify({ startAt: startAt.toISOString() }) }),
        later ? "Accepted. Its timer resumes as scheduled." : t.budget_hours != null ? "Accepted. Timer running again." : "Accepted.");
  };

  function checkHours(t: Task) {
    const now = new Date();
    if (t.budget_hours != null) {
      const close = officeCloseToday(now);
      const alreadyClosed = now >= close;
      const wouldEnd = new Date(now.getTime() + Number(t.budget_hours) * 3_600_000);
      if (alreadyClosed || wouldEnd > close) {
        const mins = alreadyClosed ? 0 : Math.max(0, Math.round((close.getTime() - now.getTime()) / 60_000));
        setPrompt({ kind: "hours", task: t, closeIn: fmtCloseIn(mins), alreadyClosed });
        return;
      }
    }
    begin(t, now);
  }

  function proceed(t: Task) {
    if (t.editor_id && t.due_date && t.budget_hours != null) {
      const total = myTasks
        .filter((x) => x.editor_id === t.editor_id && x.due_date === t.due_date && x.accepted && x.status !== "done" && x.id !== t.id && x.budget_hours != null)
        .reduce((n, x) => n + Number(x.budget_hours), 0) + Number(t.budget_hours);
      const tier = classifyWorkload(total);
      if (tier === 1 || tier === 2) {
        setPrompt({ kind: "workload", task: t, total, tier });
        return;
      }
    }
    checkHours(t);
  }

  function act(t: Task) {
    if (t.pending_note && !t.accepted) { setPrompt({ kind: "rework", task: t }); return; }
    if (t.status === "todo" && !t.accepted) {
      run(t, () => api(`/tasks/${t.id}/accept`, { method: "POST", body: "{}" }),
        t.budget_hours != null ? "Accepted. Press Start when you begin; its timer starts then." : "Accepted. Press Start when you begin.");
      return;
    }
    proceed(t);
  }

  const close = () => setPrompt(null);
  const ui = prompt && (
    <Modal onClose={close} title={
      prompt.kind === "rework" ? "Changes were requested"
        : prompt.kind === "workload" ? (prompt.tier === 2 ? "That's a full day already" : "Heavy day ahead")
        : prompt.alreadyClosed ? "Office hours have ended for today" : "This runs past office hours"
    }>
      {prompt.kind === "rework" && (
        <>
          <p className="md-modal-p">Here's what needs changing on <b>{prompt.task.title}</b>:</p>
          <blockquote className="md-quote">{prompt.task.pending_note}</blockquote>
          <div className="formfoot">
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={() => { const t = prompt.task; setPrompt(null); proceed(t); }}>Accept and resume</button>
          </div>
        </>
      )}
      {prompt.kind === "workload" && (
        <>
          <p className="md-modal-p">
            Starting <b>{prompt.task.title}</b> brings what you've taken on for that day to <b>{fmtHours(prompt.total)}h</b>.
            {prompt.tier === 2 ? " That's more than a full office day." : " That's well past half a day."}
          </p>
          <div className="formfoot">
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={() => { const t = prompt.task; setPrompt(null); checkHours(t); }}>Start anyway</button>
          </div>
        </>
      )}
      {prompt.kind === "hours" && (
        <>
          <p className="md-modal-p">
            {prompt.alreadyClosed ? (
              <><b>{prompt.task.title}</b> needs <b>{fmtHours(Number(prompt.task.budget_hours))}h</b>, and office hours are over for today.</>
            ) : (
              <><b>{prompt.task.title}</b> needs <b>{fmtHours(Number(prompt.task.budget_hours))}h</b>, but office hours close in <b>{prompt.closeIn}</b> (6:00 PM). Starting now means finishing outside office hours.</>
            )}
          </p>
          <div className="formfoot">
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn" disabled={busyId === prompt.task.id} onClick={() => begin(prompt.task, nineAmTomorrow(new Date()))}>Start 9 AM tomorrow</button>
            <button className="btn btn-primary" disabled={busyId === prompt.task.id} onClick={() => begin(prompt.task, new Date())}>Start now</button>
          </div>
        </>
      )}
    </Modal>
  );
  return { act, busyId, ui };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Card({ title, sub, action, id, className, flush, children }: {
  title: string; sub?: string; action?: ReactNode; id?: string; className?: string; flush?: boolean; children: ReactNode;
}) {
  return (
    <section id={id} className={"md-card" + (flush ? " flush" : "") + (className ? " " + className : "")}>
      <header className="md-card-head">
        <h2>{title}</h2>
        {sub && <span className="md-card-sub">{sub}</span>}
        <span className="md-grow-x" />
        {action}
      </header>
      {children}
    </section>
  );
}

function Ring({ size, frac, big, small, label }: { size: number; frac: number; big: string; small?: string; label: string }) {
  const c = 163.4; // 2πr for r = 26 in a 64-unit box
  const f = Math.max(0, Math.min(1, frac));
  return (
    <span className="md-ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="26" className="md-ring-track" />
        {f > 0 && <circle cx="32" cy="32" r="26" className="md-ring-fill" strokeDasharray={`${(c * f).toFixed(1)} ${c}`} />}
      </svg>
      <span className="md-ring-c"><b style={{ fontSize: Math.round(size * 0.2) }}>{big}</b>{small && <span>{small}</span>}</span>
    </span>
  );
}

export function Bar({ pct }: { pct: number }) {
  return <div className="md-bar"><div className="md-bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;
}

const ic = (d: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
const Icon = {
  overdue: ic(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5M12 16h.01" /></>),
  today: ic(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>),
  review: ic(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="m8 10 2 2 4-4" /></>),
  ontime: ic(<><path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6z" /><path d="m9 12 2 2 4-4" /></>),
};

type CountKey = keyof MyDayData["counts"];
function countItems(d: MyDayData): { key: CountKey; tone: string; label: string; to: string }[] {
  return [
    { key: "overdue", tone: "bad", label: d.teamScope ? "team tasks overdue" : "overdue", to: "/tasks" },
    { key: "dueToday", tone: "warn", label: d.teamScope ? "team tasks due today" : "due today", to: "/tasks" },
    { key: "inReview", tone: "rev", label: d.teamScope ? "waiting for your review" : "in review", to: "/tasks" },
    { key: "awaitingMetrics", tone: "ac", label: "posts need metrics", to: "/posts" },
  ];
}

// The four counts as one row of tinted chips (Focus).
function CountChips({ d }: { d: MyDayData }) {
  return (
    <div className="md-chips">
      {countItems(d).map((c) => (
        <Link key={c.key} to={c.to} className={"md-chip-count " + c.tone} title={d.countNotes[c.key]}>
          <b>{d.loading ? "–" : d.counts[c.key]}</b>{c.key === "overdue" || c.key === "dueToday" ? c.label.replace(/^team tasks /, "") : c.label}
        </Link>
      ))}
    </div>
  );
}

function spark(values: (number | null)[], w = 100, h = 28) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return "";
  const max = Math.max(...pts.map((p) => p[1]));
  const min = Math.min(...pts.map((p) => p[1]));
  const span = max - min || 1;
  return pts.map(([i, v], k) => `${k ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
}

// The four counts as tiles with a trend line where the tasks can show one (Dashboard).
function StatTiles({ d }: { d: MyDayData }) {
  const o = d.series.overdue;
  const delta = o[6] - o[5];
  const tiles = [
    { tone: "bad", icon: Icon.overdue, label: "Overdue", v: String(d.counts.overdue),
      chip: delta === 0 ? "same as yesterday" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} since yesterday`, chipTone: delta > 0 ? "bad" : "quiet",
      line: spark(o), to: "/tasks", title: d.countNotes.overdue },
    { tone: "warn", icon: Icon.today, label: "Due today", v: String(d.counts.dueToday), chip: d.countNotes.dueToday, chipTone: "warn",
      line: spark(d.series.dueToday), to: "/tasks", title: "Due on each of the last 7 days" },
    { tone: "rev", icon: Icon.review, label: d.teamScope ? "Awaiting review" : "In review", v: String(d.counts.inReview),
      chip: d.teamScope && d.waitingOnYou ? `avg ${fmtWait(d.avgReviewWait)} wait` : d.countNotes.inReview, chipTone: "quiet",
      line: "", to: "/tasks", title: d.countNotes.inReview },
    { tone: "good", icon: Icon.ontime, label: "On-time rate", v: d.onTime.pct == null ? "–" : `${d.onTime.pct}%`,
      chip: `${d.onTime.finished} finished this month`, chipTone: "good",
      line: spark(d.series.onTime), to: "/leaderboard", title: "Share of tasks finished by their due date, this month" },
  ];
  return (
    <div className="md-stats">
      {tiles.map((s) => (
        <Link key={s.label} to={s.to} className={"md-stat " + s.tone} title={s.title}>
          <span className="md-stat-top"><span className="md-stat-ic">{s.icon}</span>{s.label}</span>
          <span className="md-stat-row">
            <b className="md-stat-v">{d.loading ? "–" : s.v}</b>
            <span className={"md-delta " + s.chipTone}>{s.chip}</span>
            {s.line && <svg className="md-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path d={s.line} /></svg>}
          </span>
        </Link>
      ))}
    </div>
  );
}

// The row action — Start / Accept (the Task Board's rules) or Open.
function RowAction({ t, flow, onOpen }: { t: Task; flow: ReturnType<typeof useStartFlow>; onOpen: (id: string) => void }) {
  const a = actionOf(t);
  if (a === "open") return <button type="button" className="md-act" onClick={() => onOpen(t.id)}>Open</button>;
  return (
    <button type="button" className="md-act primary" disabled={flow.busyId === t.id} onClick={() => flow.act(t)}>
      {flow.busyId === t.id ? "…" : a === "start" ? "Start" : "Accept"}
    </button>
  );
}

const SHOW_TASKS = 8;

// Your open tasks, grouped by urgency, each with its next action (Focus).
export function UpNext({ d, onOpen, flow }: { d: MyDayData; onOpen: (id: string) => void; flow: ReturnType<typeof useStartFlow> }) {
  if (d.loading) return <div className="md-empty">Loading…</div>;
  if (!d.linked) return <div className="md-empty">Nothing personal to show until you're on the team roster.</div>;
  if (d.myTasks.length === 0) return <div className="md-empty">You're clear for today.</div>;
  let shown = 0;
  const more = d.myTasks.length - SHOW_TASKS;
  return (
    <>
      {groupTasks(d.myTasks, d.today).map((g) => {
        const rows = g.tasks.slice(0, Math.max(0, SHOW_TASKS - shown));
        shown += rows.length;
        if (!rows.length) return null;
        return (
          <div key={g.key}>
            <div className={"md-group " + g.key}>{g.label}</div>
            {rows.map((t) => {
              const due = dueOf(t, d.today);
              return (
                <div key={t.id} className="md-row">
                  <span className={"md-dot " + g.key} />
                  <button type="button" className="md-row-main" onClick={() => onOpen(t.id)}>
                    <b>{t.title}</b>
                    <span>{[taskRef(t), t.channel_name, noteOf(t, d.nowMs)].filter(Boolean).join(" · ")}</span>
                  </button>
                  <span className={"md-due " + due.tone}>{due.label}</span>
                  <RowAction t={t} flow={flow} onOpen={onOpen} />
                </div>
              );
            })}
          </div>
        );
      })}
      {more > 0 && <Link to="/tasks" className="md-more">{more} more on the Task Board</Link>}
    </>
  );
}

// Open tasks in scope as a table with status filters (Dashboard).
function TaskTable({ d, onOpen }: { d: MyDayData; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "todo" | "in_progress" | "review" | "sent">("all");
  const list = d.teamScope ? d.scopeTasks : d.myTasks;
  const isSent = (t: Task) => !!t.pending_note && t.status !== "review";
  const opts = useMemo(() => [
    { key: "all" as const, label: "All", n: list.length },
    { key: "todo" as const, label: "To do", n: list.filter((t) => t.status === "todo" && !isSent(t)).length },
    { key: "in_progress" as const, label: "In progress", n: list.filter((t) => t.status === "in_progress" && !isSent(t)).length },
    { key: "review" as const, label: "In review", n: list.filter((t) => t.status === "review").length },
    { key: "sent" as const, label: "Sent back", n: list.filter(isSent).length },
  ], [list]);
  const shown = list
    .filter((t) => filter === "all" || (filter === "sent" ? isSent(t) : t.status === filter && (filter === "review" || !isSent(t))))
    .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
  const more = shown.length - 10;
  return (
    <Card title={d.teamScope ? "The team's open tasks" : "Your open tasks"} flush className="md-wide" action={
      <div className="md-pills" role="group" aria-label="Show tasks">
        {opts.map((o) => (
          <button key={o.key} type="button" aria-pressed={filter === o.key} className={filter === o.key ? "on" : undefined} onClick={() => setFilter(o.key)}>
            {o.label} {o.n}
          </button>
        ))}
      </div>
    }>
      {d.loading ? <div className="md-empty pad">Loading…</div>
        : shown.length === 0 ? <div className="md-empty pad">Nothing here.</div>
        : (
          <>
            {shown.slice(0, 10).map((t) => {
              const due = dueOf(t, d.today);
              const pill = pillOf(t);
              return (
                <button key={t.id} type="button" className="md-trow" onClick={() => onOpen(t.id)}>
                  <Initials name={t.editor_name ?? "Unassigned"} size={26} round />
                  <span className="md-row-main as-span">
                    <b>{t.title}</b>
                    <span>{[taskRef(t), t.editor_name ?? "Unassigned", t.channel_name].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={"md-pill " + pill.tone}>{pill.label}</span>
                  <span className={"md-due " + due.tone}>{due.label}</span>
                </button>
              );
            })}
            {more > 0 && <Link to="/tasks" className="md-more pad">{more} more on the Task Board</Link>}
          </>
        )}
    </Card>
  );
}

// Approve or send back, right here. Sending back needs a note (the assignee
// sees it when they pick the task up again), so it opens a note box first.
export function ReviewList({ d, onOpen, onChanged, stacked }: {
  d: MyDayData; onOpen: (id: string) => void; onChanged: () => Promise<unknown>; stacked?: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function resolve(t: Task, status: "done" | "in_progress", reviewNote?: string) {
    // Approving work that was never attached needs a deliberate yes.
    const noWork = status === "done" && t.link_required && !t.delivery_link;
    if (noWork && !window.confirm(`No work is attached to "${t.title}". Approve it anyway?`)) return;
    setBusyId(t.id);
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({
        status, ...(reviewNote ? { reviewNote } : {}), ...(noWork ? { approveWithoutWork: true } : {}),
      }) });
      toast.success(status === "done" ? `Approved “${t.title}”.` : `Sent “${t.title}” back for changes.`);
      setNoteFor(null);
      setNote("");
      await onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update that task.");
    } finally {
      setBusyId(null);
    }
  }

  if (d.loading) return <div className="md-empty pad">Loading…</div>;
  if (d.reviewQueue.length === 0) return <div className="md-empty pad center">Inbox zero. Nothing is waiting on you.</div>;
  return (
    <>
      {d.reviewQueue.map((t) => {
        const busy = busyId === t.id;
        const wait = reviewWaitMs(t, d.nowMs);
        const who = t.editor_name ?? "Unassigned";
        return (
          <div key={t.id} className={"md-review" + (stacked ? " stacked" : "")}>
            <Initials name={who} size={30} />
            <button type="button" className="md-row-main" onClick={() => onOpen(t.id)}>
              <b>{t.title}</b>
              <span>
                {[who, taskRef(t)].filter(Boolean).join(" · ")}
                {t.review_started_at && <em className={wait >= SLOW_REVIEW_MS ? "slow" : undefined}> · waiting {fmtWait(wait)}</em>}
                {t.self_created && " · self-created"}
                {!t.delivery_link && t.link_required && " · no work attached"}
              </span>
            </button>
            {noteFor === t.id ? (
              <form className="md-review-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) resolve(t, "in_progress", note.trim()); }}>
                <input className="t" autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder={`What does ${who} need to change?`} aria-label="What needs changing" />
                <button type="submit" className="md-act primary" disabled={busy || !note.trim()}>{busy ? "Sending…" : "Send back"}</button>
                <button type="button" className="md-act" disabled={busy} onClick={() => { setNoteFor(null); setNote(""); }}>Cancel</button>
              </form>
            ) : (
              <div className="md-review-actions">
                {t.delivery_link && <a className="md-act" href={t.delivery_link} target="_blank" rel="noreferrer">See the work</a>}
                <button type="button" className="md-act" disabled={busy} onClick={() => { setNoteFor(t.id); setNote(""); }}>Send back</button>
                <button type="button" className="md-act approve" disabled={busy} onClick={() => resolve(t, "done")}>{busy ? "Approving…" : "Approve"}</button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function todayFrac(d: MyDayData) {
  const total = d.completedToday + d.myTasks.length;
  return { total, frac: total ? d.completedToday / total : 0 };
}

// Today: done so far, points, focus time and the daily goal (Focus).
function TodayCard({ d }: { d: MyDayData }) {
  const { total, frac } = todayFrac(d);
  return (
    <Card title="Today">
      <div className="md-today">
        <Ring size={72} frac={frac} big={`${d.completedToday}/${total}`} small="done" label={`${d.completedToday} of ${total} tasks done today`} />
        <div className="md-today-txt">
          <b>{d.completedToday} done, {d.myTasks.length} to go</b>
          {d.clockedInSince && <span>Clocked in since {d.clockedInSince}</span>}
        </div>
      </div>
      <div className="md-kv"><span>Points today</span><b>{Math.round(d.pointsToday)}</b></div>
      <div className="md-kv"><span title="Worked out from task time budgets, not tracked exactly">Focus time</span><b>{hoursMins(d.focusSeconds)}</b></div>
      <div className="md-kv"><span>Daily goal</span><b>{d.dailyGoalPct == null ? "–" : `${d.dailyGoalPct}%`}</b></div>
      {d.dailyGoalPct != null && <Bar pct={d.dailyGoalPct} />}
    </Card>
  );
}

function rankText(w: RankWindow) {
  if (!w.counted) return "exempt from task scoring";
  return w.rank ? `${ordinal(w.rank)} of ${w.totalRanked}` : "not ranked yet";
}
function goalPace(goal: NonNullable<Goal>, daysLeft: number) {
  if (goal.toGo <= 0) return "Goal reached.";
  const per = Math.ceil(goal.toGo / Math.max(1, daysLeft));
  return `${goal.toGo} to go, about ${per} a working day.`;
}

// Your score as rows (Focus).
function ScoreCard({ d, goal }: { d: MyDayData; goal: Goal }) {
  if (!d.week || !d.month) return null;
  return (
    <Card title="Your score" action={<Link to="/leaderboard" className="md-link">Leaderboard</Link>}>
      <div className="md-kv"><span>This week</span><b>{Math.round(d.week.points)} pts · {rankText(d.week)}</b></div>
      <div className="md-kv"><span>This month</span><b>{Math.round(d.month.points)} pts · {rankText(d.month)}</b></div>
      {goal ? (
        <>
          <div className="md-kv"><span>{monthName()} goal</span><b>{goal.done} of {goal.target} tasks</b></div>
          <Bar pct={goal.pct} />
          <span className="md-faint">{goalPace(goal, d.workingDaysLeft)}</span>
        </>
      ) : <span className="md-faint">No task goal set for this month yet.</span>}
    </Card>
  );
}

// Points per day this week, one bar a day (Dashboard).
function WeekCard({ d }: { d: MyDayData }) {
  if (!d.weekDays || !d.week) return null;
  const max = Math.max(1, ...d.weekDays.map((x) => x.points));
  return (
    <Card title="This week" action={<span className="md-badge">{rankText(d.week)}</span>}>
      <div className="md-bignum">{Math.round(d.week.points)} <span>points</span></div>
      <div className="md-weekbars" role="img" aria-label={"Points per day this week: " + d.weekDays.filter((x) => !x.future).map((x) => `${x.label} ${Math.round(x.points)}`).join(", ")}>
        {d.weekDays.map((x) => (
          <div key={x.date} className="md-wb" title={`${x.label}: ${x.future ? "still to come" : Math.round(x.points) + " points"}`}>
            <div className={"md-wb-bar" + (x.isToday ? " today" : x.future ? " future" : "")} style={{ height: `${Math.max(4, (x.points / max) * 100)}%` }} />
            <span className={x.isToday ? "today" : undefined}>{x.label.charAt(0)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// The month's points and goal ring (Dashboard).
function MonthCard({ d, goal }: { d: MyDayData; goal: Goal }) {
  if (!d.month) return null;
  return (
    <Card title="This month" action={<span className="md-badge">{rankText(d.month)}</span>}>
      <div className="md-month">
        {goal && <Ring size={84} frac={goal.pct / 100} big={`${goal.pct}%`} label={`${goal.done} of ${goal.target} goal tasks done`} />}
        <div>
          <div className="md-bignum">{Math.round(d.month.points)} <span>points</span></div>
          <span className="md-faint">{goal ? `${monthName()} goal: ${goal.done} of ${goal.target} tasks. ${goalPace(goal, d.workingDaysLeft)}` : "No task goal set yet."}</span>
        </div>
      </div>
    </Card>
  );
}

// Views on posts published each day this month, as one filled line (Dashboard).
function ViewsChart({ d }: { d: MyDayData }) {
  const s = d.viewsByDay;
  const max = Math.max(0, ...s.map((x) => x.views));
  if (!s.length || max === 0) return <div className="md-empty">No views on this month's posts yet.</div>;
  const W = 600, H = 150;
  const x = (i: number) => (s.length === 1 ? W / 2 : (i * W) / (s.length - 1));
  const y = (v: number) => H - 6 - (v / max) * (H - 18);
  const line = s.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.views).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const last = s[s.length - 1];
  const mon = new Date().toLocaleDateString("en-GB", { month: "short" });
  const mid = s[Math.floor((s.length - 1) / 2)];
  return (
    <>
      <div className="md-chart" role="img" aria-label={`Views on posts published each day this month; the best day had ${compactNum(max)}`}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="md-vfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="md-stop-a" /><stop offset="1" className="md-stop-b" /></linearGradient></defs>
          <path d={area} fill="url(#md-vfill)" />
          <path d={line} className="md-line" />
          {s.map((p, i) => (
            <rect key={p.day} x={x(i) - W / s.length / 2} y="0" width={W / s.length} height={H} fill="transparent">
              <title>{`${p.day} ${mon}: ${compactNum(p.views)} views`}</title>
            </rect>
          ))}
        </svg>
        <span className="md-chart-tag">{compactNum(last.views)} today</span>
      </div>
      <div className="md-axis"><span>1 {mon}</span><span>{mid.day} {mon}</span><span>{last.day} {mon}</span></div>
    </>
  );
}

function PipelineStack({ d }: { d: MyDayData }) {
  const total = STAGES.reduce((a, s) => a + (d.pipeline[s.key] ?? 0), 0);
  if (!total) return <div className="md-empty">No content in the pipeline yet.</div>;
  return (
    <div className="md-pipe">
      <span className="md-pipe-head">Editing pipeline · <b>{total}</b> {total === 1 ? "piece" : "pieces"}</span>
      <div className="md-stack" role="img" aria-label={"Pipeline: " + STAGES.map((s) => `${d.pipeline[s.key] ?? 0} ${s.label.toLowerCase()}`).join(", ")}>
        {STAGES.map((s) => (d.pipeline[s.key] ?? 0) > 0 && (
          <span key={s.key} className={"md-seg " + s.tone} style={{ width: `${((d.pipeline[s.key] ?? 0) / total) * 100}%` }} title={`${s.label}: ${d.pipeline[s.key]}`} />
        ))}
      </div>
      <div className="md-legend">
        {STAGES.map((s) => <span key={s.key}><span className={"md-swatch " + s.tone} /><b>{d.pipeline[s.key] ?? 0}</b>{s.label}</span>)}
      </div>
    </div>
  );
}

function PipelineBars({ d }: { d: MyDayData }) {
  const total = STAGES.reduce((a, s) => a + (d.pipeline[s.key] ?? 0), 0);
  if (!total) return <div className="md-empty">No content in the pipeline yet.</div>;
  return (
    <div className="md-hbars">
      {STAGES.map((s) => (
        <div key={s.key} className="md-hbar" title={`${s.label}: ${d.pipeline[s.key] ?? 0}`}>
          <span>{s.label}</span>
          <div className="md-hbar-track"><div className={"md-seg " + s.tone} style={{ width: `${((d.pipeline[s.key] ?? 0) / total) * 100}%` }} /></div>
          <b>{d.pipeline[s.key] ?? 0}</b>
        </div>
      ))}
    </div>
  );
}

function MonthNumbers({ d }: { d: MyDayData }) {
  const a = d.analytics;
  return (
    <div className="md-nums">
      <div><b>{d.loading ? "–" : compactNum(a.views)}</b><span>Views</span></div>
      <div><b>{a.engRate == null ? "–" : a.engRate.toFixed(1) + "%"}</b><span>Engagement</span></div>
      <div><b>{d.loading ? "–" : a.posts}</b><span>Posts published</span></div>
    </div>
  );
}

function BestPost({ d }: { d: MyDayData }) {
  const p = d.analytics.top;
  return (
    <div className="md-best">
      {p?.thumbnail_url ? <img className="md-thumb" src={p.thumbnail_url} alt="" /> : <span className="md-thumb" aria-hidden="true" />}
      <div className="md-best-txt">
        <span className="md-best-k">Best post this month</span>
        {p ? (
          <>
            <b>{p.title}</b>
            <span>{[`Score ${formatScore(p)}`, `${compactNum(p.views)} views`, `${compactNum(p.saves)} saves`].join(" · ")}</span>
          </>
        ) : <span>No published posts this month yet.</span>}
      </div>
    </div>
  );
}

const linkTo = (to: string, label: string) => <Link to={to} className="md-link">{label}</Link>;

// ---------------------------------------------------------------------------
// The three layouts
// ---------------------------------------------------------------------------

type LayoutProps = { d: MyDayData; goal: Goal; onOpen: (id: string) => void; onChanged: () => Promise<unknown>; flow: ReturnType<typeof useStartFlow> };

function ReviewCard({ d, onOpen, onChanged, stacked, full }: { d: MyDayData; onOpen: (id: string) => void; onChanged: () => Promise<unknown>; stacked?: boolean; full?: boolean }) {
  if (!d.canReview) return null;
  return (
    <Card title="Waiting for your review" flush id="review"
      sub={full ? `${d.reviewQueue.length} ${d.reviewQueue.length === 1 ? "item" : "items"}` : undefined}
      action={full && d.reviewQueue.length ? <span className="md-faint">Longest wait {fmtWait(d.oldestReviewWait)}</span> : undefined}>
      <ReviewList d={d} onOpen={onOpen} onChanged={onChanged} stacked={stacked} />
    </Card>
  );
}

function FocusLayout({ d, goal, onOpen, onChanged, flow }: LayoutProps) {
  return (
    <>
      <CountChips d={d} />
      <div className="md-split">
        <div className="md-col wide">
          <Card title="Up next" sub="Your open tasks, most urgent first" flush action={linkTo("/tasks", "Open Task Board")}>
            <UpNext d={d} onOpen={onOpen} flow={flow} />
          </Card>
        </div>
        {d.linked && (
          <div className="md-col">
            <TodayCard d={d} />
            <ScoreCard d={d} goal={goal} />
          </div>
        )}
      </div>
      <ReviewCard d={d} onOpen={onOpen} onChanged={onChanged} full />
      <Card title="The team this month" action={<span className="md-links">{linkTo("/metrics", "Pipeline")}{linkTo("/analytics", "Analytics")}</span>}>
        <div className="md-teamstrip">
          <div className="md-teamstrip-pipe"><PipelineStack d={d} /></div>
          <MonthNumbers d={d} />
          <BestPost d={d} />
        </div>
      </Card>
    </>
  );
}

function DashboardLayout({ d, goal, onOpen, onChanged }: LayoutProps) {
  const { total, frac } = todayFrac(d);
  return (
    <>
      <StatTiles d={d} />
      <div className="md-split stretch">
        <TaskTable d={d} onOpen={onOpen} />
        {d.linked && (
          <Card title="Today's progress" className="md-narrow">
            <div className="md-center"><Ring size={120} frac={frac} big={`${d.completedToday}/${total}`} small="tasks done" label={`${d.completedToday} of ${total} tasks done today`} /></div>
            <div className="md-trio">
              <div><b>{Math.round(d.pointsToday)}</b><span>points</span></div>
              <div><b>{hoursMins(d.focusSeconds)}</b><span title="Worked out from task time budgets, not tracked exactly">focus</span></div>
              <div><b>{d.dailyGoalPct == null ? "–" : `${d.dailyGoalPct}%`}</b><span>daily goal</span></div>
            </div>
          </Card>
        )}
      </div>
      <div className="md-grid3">
        <ReviewCard d={d} onOpen={onOpen} onChanged={onChanged} stacked />
        {d.linked && <WeekCard d={d} />}
        {d.linked && <MonthCard d={d} goal={goal} />}
      </div>
      <div className="md-split stretch">
        <Card title="Views this month" action={linkTo("/analytics", "Open Analytics")} className="md-wide">
          <MonthNumbers d={d} />
          <ViewsChart d={d} />
        </Card>
        <Card title="Editing pipeline" action={linkTo("/metrics", "Open")} className="md-narrow">
          <PipelineBars d={d} />
          <div className="md-divide"><BestPost d={d} /></div>
        </Card>
      </div>
    </>
  );
}

function TeamLayout({ d, goal, onOpen, onChanged }: LayoutProps) {
  const { total } = todayFrac(d);
  const segs = Math.min(total, 12);
  const on = total ? Math.round((d.completedToday / total) * segs) : 0;
  return (
    <div className="md-lanes">
      <div className="md-lane me">
        <div className="md-lane-head"><h2>Your day</h2><span>What's on your plate and how you're doing</span></div>
        {d.linked ? (
          <section className="md-card md-band">
            <div className="md-band-progress">
              <b>{d.completedToday} of {total} tasks done</b>
              <div className="md-steps" aria-hidden="true">{Array.from({ length: segs }, (_, i) => <span key={i} className={i < on ? "on" : undefined} />)}</div>
            </div>
            <div className="md-trio inline">
              <div><b>{Math.round(d.pointsToday)}</b><span>points today</span></div>
              <div><b>{hoursMins(d.focusSeconds)}</b><span title="Worked out from task time budgets, not tracked exactly">focus</span></div>
              <div><b>{d.dailyGoalPct == null ? "–" : `${d.dailyGoalPct}%`}</b><span>of daily goal</span></div>
            </div>
          </section>
        ) : null}
        <Card title="Your tasks" flush action={linkTo("/tasks", "Open Task Board")}>
          {!d.linked ? <div className="md-empty pad">Nothing personal to show until you're on the team roster.</div>
            : d.myTasks.length === 0 ? <div className="md-empty pad">You're clear for today.</div>
            : d.myTasks.slice(0, SHOW_TASKS).map((t) => {
              const due = dueOf(t, d.today);
              return (
                <button key={t.id} type="button" className="md-trow lane" onClick={() => onOpen(t.id)}>
                  <span className={"md-pill " + due.tone}>{due.label}</span>
                  <span className="md-row-main as-span"><b>{t.title}</b><span>{[taskRef(t), noteOf(t, d.nowMs)].filter(Boolean).join(" · ")}</span></span>
                  <span className="md-faint">{t.channel_name ?? ""}</span>
                </button>
              );
            })}
        </Card>
        {d.linked && d.week && d.month && (
          <Card title="Your score" action={linkTo("/leaderboard", "Leaderboard")}>
            <div className="md-tiles3">
              <div><span>This week</span><b>{Math.round(d.week.points)}</b><span>points · {rankText(d.week)}</span></div>
              <div><span>This month</span><b>{Math.round(d.month.points)}</b><span>points · {rankText(d.month)}</span></div>
              <div>
                <span>{monthName()} goal</span>
                {goal ? <><b>{goal.pct}%</b><Bar pct={goal.pct} /><span>{goal.done} of {goal.target} · {goal.toGo > 0 ? `${goal.toGo} to go` : "reached"}</span></> : <span className="md-gap">No task goal set yet</span>}
              </div>
            </div>
          </Card>
        )}
      </div>
      <div className="md-lane team">
        <div className="md-lane-head"><h2>The team</h2><span>{!d.isAdmin ? "How the team is doing this month" : d.teamScope ? "What needs you as a lead" : "Showing just your own numbers"}</span></div>
        <div className="md-tiles2">
          {countItems(d).map((c) => (
            <Link key={c.key} to={c.to} className={"md-tile " + c.tone} title={d.countNotes[c.key]}>
              <b>{d.loading ? "–" : d.counts[c.key]}</b><span>{c.label}</span>
            </Link>
          ))}
        </div>
        <ReviewCard d={d} onOpen={onOpen} onChanged={onChanged} stacked />
        <Card title="This month" action={linkTo("/analytics", "Analytics")}>
          <MonthNumbers d={d} />
          <div className="md-divide"><PipelineStack d={d} /></div>
          <div className="md-divide"><BestPost d={d} /></div>
        </Card>
      </div>
    </div>
  );
}

export function MyDayBody({ data, onOpenTask, onChanged }: {
  data: MyDayData; onOpenTask: (id: string) => void; onChanged: () => Promise<unknown>;
}) {
  const [layout, setLayout] = useState<Layout>(readLayout);
  const goal = useMyGoal(data.linked);
  const flow = useStartFlow(data.myTasks, onChanged);
  function pick(l: Layout) {
    setLayout(l);
    try { window.localStorage.setItem(LAYOUT_KEY, l); } catch { /* not remembered, still switches */ }
  }
  const longDate = new Date(data.nowMs).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const summary = `${longDate} · ${data.openCount} open task${data.openCount === 1 ? "" : "s"} ${data.teamScope ? "across the team" : "of yours"} · ${data.waitingOnYou} waiting on you`;
  const props: LayoutProps = { d: data, goal, onOpen: onOpenTask, onChanged, flow };
  return (
    <div className="md-body">
      <div className="md-top">
        <div className="md-tabs" role="tablist" aria-label="My Day layout">
          {LAYOUTS.map((l) => (
            <button key={l.key} type="button" role="tab" aria-selected={layout === l.key} className={layout === l.key ? "on" : undefined} onClick={() => pick(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
        <span className="md-grow-x" />
        <span className="md-summary">{data.loading ? "" : summary}</span>
      </div>
      {data.hint && <p className="md-hint">{data.hint}</p>}
      {layout === "focus" && <FocusLayout {...props} />}
      {layout === "dashboard" && <DashboardLayout {...props} />}
      {layout === "team" && <TeamLayout {...props} />}
      {flow.ui}
    </div>
  );
}
