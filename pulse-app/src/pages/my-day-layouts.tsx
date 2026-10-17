import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { compactNum } from "@/lib/date-range";
import { formatScore } from "@/lib/score";
import { daysBetween } from "@/lib/task-points";
import { fmtWait, reviewWaitMs, SLOW_REVIEW_MS } from "@/lib/task-timing";
import type { Post, Task } from "@/lib/types";
import "./my-day.css";

// Everything on My Day under the hero banner, in three layouts the viewer picks
// between (remembered in this browser): Me and Team (your work beside team
// oversight), Focus (one calm list of what needs you) and Dashboard (charts).
// home.tsx works the numbers out once and hands them here as MyDayData; the
// layouts only arrange the same sections differently.

type RankWindow = { points: number; completed: number; rank: number | null; totalRanked: number };

export type MyDayData = {
  loading: boolean;
  today: string;
  nowMs: number;
  isAdmin: boolean;
  // On the team roster — without that there's nothing personal to show.
  linked: boolean;
  // The one line shown above everything when the page can't be personal.
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

type Layout = "lanes" | "focus" | "dashboard";
const LAYOUTS: { key: Layout; label: string }[] = [
  { key: "lanes", label: "Me and Team" },
  { key: "focus", label: "Focus" },
  { key: "dashboard", label: "Dashboard" },
];
const LAYOUT_KEY = "pulse-myday-layout";

function readLayout(): Layout {
  try {
    const v = window.localStorage.getItem(LAYOUT_KEY);
    if (v === "lanes" || v === "focus" || v === "dashboard") return v;
  } catch { /* private window — fall back */ }
  return "lanes";
}

const STAGES: { key: string; label: string }[] = [
  { key: "not_started", label: "Not started" },
  { key: "in_progress", label: "In progress" },
  { key: "in_review", label: "In review" },
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Completed" },
];

const STATUS_TEXT: Record<string, string> = { todo: "Not started", in_progress: "In progress", review: "In review", done: "Done" };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hoursMins(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

// The number people know a task by: its brand's SID/AID/SVID/PID, else the TID.
function taskRef(t: Task) {
  return t.sid || t.ad_id?.replace(/^AdID/i, "AID") || t.svid || t.pid || t.tid || "";
}

function statusText(t: Task) {
  return t.pending_note ? "Sent back for changes" : STATUS_TEXT[t.status] ?? t.status;
}

function dueText(t: Task, today: string) {
  if (!t.due_date) return "No due date";
  const d = daysBetween(today, t.due_date);
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} late`;
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  // en-GB like the banner's date: "Tue 20 Oct".
  return new Date(t.due_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
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
function useMyGoal(enabled: boolean) {
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

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Card({ title, sub, action, id, className, children }: {
  title: string; sub?: string; action?: ReactNode; id?: string; className?: string; children: ReactNode;
}) {
  return (
    <section id={id} className={"md-card" + (className ? " " + className : "")}>
      <header className="md-card-head">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Ring({ size, stroke, frac, tone = "accent", big, small, label }: {
  size: number; stroke: number; frac: number; tone?: "accent" | "good"; big: string; small?: string; label: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="md-ring">
      <circle cx={size / 2} cy={size / 2} r={r} className="md-ring-track" strokeWidth={stroke} />
      {f > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r} className={"md-ring-fill " + tone} strokeWidth={stroke}
          strokeDasharray={`${c * f} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
      <text x="50%" y={small ? "47%" : "53%"} textAnchor="middle" className="md-ring-big" style={{ fontSize: size * 0.22 }}>{big}</text>
      {small && <text x="50%" y="64%" textAnchor="middle" className="md-ring-small" style={{ fontSize: Math.max(10, size * 0.085) }}>{small}</text>}
    </svg>
  );
}

function Bar({ pct, tone = "accent" }: { pct: number; tone?: "accent" | "good" }) {
  return <div className="md-bar"><div className={"md-bar-fill " + tone} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;
}

const Icon = {
  clock: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  calendar: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>,
  eye: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  chart: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V11M10 20V5M16 20v-6M2 20h20" /></svg>,
};

type CountKey = keyof MyDayData["counts"];
function countItems(d: MyDayData): { key: CountKey; tone: string; label: string; to: string; icon: ReactNode }[] {
  return [
    { key: "overdue", tone: "rose", label: d.isAdmin ? "team tasks overdue" : "overdue", to: "/tasks", icon: Icon.clock },
    { key: "dueToday", tone: "amber", label: d.isAdmin ? "team tasks due today" : "due today", to: "/tasks", icon: Icon.calendar },
    { key: "inReview", tone: "blue", label: d.isAdmin ? "waiting for review" : "in review", to: "/tasks", icon: Icon.eye },
    { key: "awaitingMetrics", tone: "accent", label: "posts need metrics", to: "/posts", icon: Icon.chart },
  ];
}

// The four counts as one row of coloured buttons (Focus).
function CountPills({ d }: { d: MyDayData }) {
  return (
    <div className="md-pills">
      {countItems(d).map((c) => (
        <Link key={c.key} to={c.to} className={"md-pill " + c.tone} title={d.countNotes[c.key]}>
          <b>{d.loading ? "–" : d.counts[c.key]}</b> {c.label}
        </Link>
      ))}
    </div>
  );
}

// The four counts as tiles: with an icon and a line of detail (Dashboard), or
// a compact 2×2 (Me and Team).
function CountTiles({ d, compact }: { d: MyDayData; compact?: boolean }) {
  return (
    <div className={"md-tiles" + (compact ? " compact" : "")}>
      {countItems(d).map((c) => (
        <Link key={c.key} to={c.to} className={"md-tile " + c.tone}>
          {!compact && <span className="md-tile-top"><span className="md-tile-ic">{c.icon}</span><span className="md-tile-label">{c.label}</span></span>}
          <b className="md-tile-n">{d.loading ? "–" : d.counts[c.key]}</b>
          {compact ? <span className="md-tile-label">{c.label}</span> : <span className="md-tile-note">{d.countNotes[c.key]}</span>}
        </Link>
      ))}
    </div>
  );
}

function TaskRow({ t, today, onOpen, chip }: { t: Task; today: string; onOpen: (id: string) => void; chip?: boolean }) {
  const due = dueText(t, today);
  const late = t.due_date != null && t.due_date < today;
  // With a due chip the brand sits on the right, so it isn't repeated here.
  const meta = [taskRef(t), chip ? null : t.channel_name, statusText(t)].filter(Boolean).join(" · ");
  return (
    <button type="button" className="md-trow" onClick={() => onOpen(t.id)}>
      {chip ? (
        <span className={"md-chip " + (late ? "rose" : t.due_date === today ? "amber" : "quiet")}>{late ? "Overdue" : due}</span>
      ) : (
        <span className={"md-dot " + (late ? "rose" : t.status === "in_progress" ? "blue" : t.status === "review" ? "amber" : "quiet")} />
      )}
      <span className="md-trow-main">
        <span className="md-trow-title">{t.title}</span>
        <span className="md-trow-meta">{meta}</span>
      </span>
      <span className={"md-trow-due" + (late ? " late" : "")}>{chip && !late ? (t.channel_name ?? "") : due}</span>
    </button>
  );
}

const SHOW_TASKS = 8;

// Your open tasks, grouped by urgency (Focus) or as one list with a due chip (Me and Team).
function TaskList({ d, onOpen, grouped }: { d: MyDayData; onOpen: (id: string) => void; grouped?: boolean }) {
  if (d.loading) return <div className="md-empty">Loading…</div>;
  if (!d.linked) return <div className="md-empty">Nothing personal to show until you're on the team roster.</div>;
  if (d.myTasks.length === 0) return <div className="md-empty">You're all caught up. Nothing open right now.</div>;
  const more = d.myTasks.length - SHOW_TASKS;
  if (!grouped) {
    return (
      <>
        <div className="md-tlist">{d.myTasks.slice(0, SHOW_TASKS).map((t) => <TaskRow key={t.id} t={t} today={d.today} onOpen={onOpen} chip />)}</div>
        {more > 0 && <Link to="/tasks" className="md-more">{more} more on the Task Board</Link>}
      </>
    );
  }
  let shown = 0;
  return (
    <>
      {groupTasks(d.myTasks, d.today).map((g) => {
        const room = Math.max(0, SHOW_TASKS - shown);
        const rows = g.tasks.slice(0, room);
        shown += rows.length;
        if (!rows.length) return null;
        return (
          <div key={g.key} className="md-group">
            <div className={"md-group-label " + g.key}>{g.label}</div>
            <div className="md-tlist">{rows.map((t) => <TaskRow key={t.id} t={t} today={d.today} onOpen={onOpen} />)}</div>
          </div>
        );
      })}
      {more > 0 && <Link to="/tasks" className="md-more">{more} more on the Task Board</Link>}
    </>
  );
}

// Your open tasks as a table you can filter by status (Dashboard).
function TaskTable({ d, onOpen }: { d: MyDayData; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "todo" | "in_progress" | "review" | "sent_back">("all");
  const filters = useMemo(() => {
    const t = d.myTasks;
    return [
      { key: "all" as const, label: "All", n: t.length },
      { key: "todo" as const, label: "Not started", n: t.filter((x) => x.status === "todo" && !x.pending_note).length },
      { key: "in_progress" as const, label: "In progress", n: t.filter((x) => x.status === "in_progress" && !x.pending_note).length },
      { key: "review" as const, label: "In review", n: t.filter((x) => x.status === "review").length },
      { key: "sent_back" as const, label: "Sent back", n: t.filter((x) => !!x.pending_note).length },
    ];
  }, [d.myTasks]);
  const shown = d.myTasks.filter((t) =>
    filter === "all" ? true : filter === "sent_back" ? !!t.pending_note : t.status === filter && (filter === "review" || !t.pending_note));
  return (
    <Card title="Your tasks" action={
      <div className="md-filters" role="group" aria-label="Show tasks">
        {filters.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} className={"md-filter" + (filter === f.key ? " on" : "")} onClick={() => setFilter(f.key)}>
            {f.label} <span>{f.n}</span>
          </button>
        ))}
      </div>
    } className="md-grow">
      {d.loading ? <div className="md-empty">Loading…</div>
        : !d.linked ? <div className="md-empty">Nothing personal to show until you're on the team roster.</div>
        : shown.length === 0 ? <div className="md-empty">Nothing here.</div>
        : (
          <div className="md-table">
            {shown.slice(0, SHOW_TASKS + 2).map((t) => {
              const late = t.due_date != null && t.due_date < d.today;
              const tone = t.pending_note || late ? "rose" : t.status === "in_progress" ? "blue" : t.status === "review" ? "amber" : "quiet";
              return (
                <button key={t.id} type="button" className="md-table-row" onClick={() => onOpen(t.id)}>
                  <span className="md-trow-main">
                    <span className="md-trow-title">{t.title}</span>
                    <span className="md-trow-meta">{[taskRef(t), t.channel_name, t.content_format_name].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={"md-chip " + tone}>{t.pending_note ? "Sent back" : STATUS_TEXT[t.status]}</span>
                  <span className={"md-trow-due" + (late ? " late" : "")}>{dueText(t, d.today)}</span>
                </button>
              );
            })}
          </div>
        )}
    </Card>
  );
}

// Approve or send back, right here. Sending back needs a note (the assignee
// sees it when they pick the task up again), so it opens a note box first.
function ReviewList({ d, onOpen, onChanged, stacked }: {
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

  if (d.loading) return <div className="md-empty">Loading…</div>;
  if (d.reviewQueue.length === 0) return <div className="md-empty">Nothing is waiting for your review.</div>;
  return (
    <div className="md-tlist">
      {d.reviewQueue.map((t) => {
        const busy = busyId === t.id;
        const wait = reviewWaitMs(t, d.nowMs);
        const who = t.editor_name ?? "Unassigned";
        return (
          <div key={t.id} className={"md-review" + (stacked ? " stacked" : "")}>
            <span className="md-review-ava" aria-hidden="true">{who.charAt(0).toUpperCase()}</span>
            <div className="md-review-main">
              <button type="button" className="md-review-title" onClick={() => onOpen(t.id)}>{t.title}</button>
              <span className="md-trow-meta">
                {who}
                {t.review_started_at && <span className={wait >= SLOW_REVIEW_MS ? "md-slow" : undefined}> · waiting {fmtWait(wait)}</span>}
                {t.self_created && " · self-created"}
                {t.delivery_link
                  ? <> · <a href={t.delivery_link} target="_blank" rel="noreferrer">open the work</a></>
                  : t.link_required ? " · no work attached" : ""}
              </span>
            </div>
            {noteFor === t.id ? (
              <form className="md-review-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) resolve(t, "in_progress", note.trim()); }}>
                <input className="t" autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder={`What does ${who} need to change?`} aria-label="What needs changing" />
                <button type="submit" className="md-btn primary" disabled={busy || !note.trim()}>{busy ? "Sending…" : "Send back"}</button>
                <button type="button" className="md-btn" disabled={busy} onClick={() => { setNoteFor(null); setNote(""); }}>Cancel</button>
              </form>
            ) : (
              <div className="md-review-actions">
                <button type="button" className="md-btn" disabled={busy} onClick={() => { setNoteFor(t.id); setNote(""); }}>Send back</button>
                <button type="button" className="md-btn approve" disabled={busy} onClick={() => resolve(t, "done")}>{busy ? "Approving…" : "Approve"}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function todayFrac(d: MyDayData) {
  const total = d.completedToday + d.myTasks.length;
  return { total, frac: total ? d.completedToday / total : 0 };
}

// Today: done so far, points, focus time and the daily goal (Focus, Dashboard).
function TodayStats({ d, big }: { d: MyDayData; big?: boolean }) {
  const { total, frac } = todayFrac(d);
  const ring = <Ring size={big ? 168 : 96} stroke={big ? 14 : 9} frac={frac} big={`${d.completedToday}/${total}`} small="done" label={`${d.completedToday} of ${total} tasks done today`} />;
  if (big) {
    return (
      <div className="md-today big">
        <div className="md-today-ring">{ring}</div>
        <div className="md-minis">
          <div className="md-mini"><b>{Math.round(d.pointsToday)}</b><span>points</span></div>
          <div className="md-mini"><b>{hoursMins(d.focusSeconds)}</b><span title="Worked out from task time budgets, not tracked exactly">focus, roughly</span></div>
          <div className="md-mini"><b>{d.dailyGoalPct == null ? "–" : `${d.dailyGoalPct}%`}</b><span>daily goal</span></div>
        </div>
      </div>
    );
  }
  return (
    <div className="md-today">
      <div className="md-today-top">
        {ring}
        <div>
          <div className="md-today-line">{d.completedToday} done, {d.myTasks.length} to go</div>
          {d.clockedInSince && <div className="md-trow-meta">Clocked in since {d.clockedInSince}</div>}
        </div>
      </div>
      <div className="md-kv"><span>Points today</span><b>{Math.round(d.pointsToday)}</b></div>
      <div className="md-kv"><span title="Worked out from task time budgets, not tracked exactly">Focus time, roughly</span><b>{hoursMins(d.focusSeconds)}</b></div>
      {d.dailyGoalPct != null && (
        <div>
          <div className="md-kv"><span>Daily goal</span><b>{d.dailyGoalPct}%</b></div>
          <Bar pct={d.dailyGoalPct} />
        </div>
      )}
    </div>
  );
}

function rankText(w: RankWindow) {
  return w.rank ? `${ordinal(w.rank)} of ${w.totalRanked}` : "not ranked yet";
}

function GoalBlock({ goal }: { goal: Goal }) {
  if (!goal) return <div className="md-trow-meta">No task goal set for this month yet.</div>;
  return (
    <div>
      <div className="md-kv"><span>Monthly goal</span><span><b>{goal.done}</b> of {goal.target} tasks</span></div>
      <Bar pct={goal.pct} tone="good" />
      <div className="md-trow-meta md-gap">{goal.toGo > 0 ? `${goal.toGo} to go` : "Goal reached"}</div>
    </div>
  );
}

// Your score as rows (Focus).
function ScoreRows({ d, goal }: { d: MyDayData; goal: Goal }) {
  if (!d.week || !d.month) return null;
  return (
    <div className="md-scorerows">
      <div className="md-kv row"><span>This week</span><span><b className="md-num">{Math.round(d.week.points)}</b> pts · {rankText(d.week)}</span></div>
      <div className="md-kv row"><span>This month</span><span><b className="md-num">{Math.round(d.month.points)}</b> pts · {rankText(d.month)}</span></div>
      <div className="md-scorerows-goal"><GoalBlock goal={goal} /></div>
      <Link to="/leaderboard" className="md-more">See the leaderboard</Link>
    </div>
  );
}

// Your score as three tiles (Me and Team).
function ScoreTiles({ d, goal }: { d: MyDayData; goal: Goal }) {
  if (!d.week || !d.month) return null;
  return (
    <div className="md-scoretiles">
      <div className="md-scoretile"><span>This week</span><b>{Math.round(d.week.points)}</b><span>points · {rankText(d.week)}</span></div>
      <div className="md-scoretile"><span>This month</span><b>{Math.round(d.month.points)}</b><span>points · {rankText(d.month)}</span></div>
      <div className="md-scoretile wide">
        <span>Monthly goal</span>
        {goal ? (
          <>
            <b>{goal.pct}%</b>
            <Bar pct={goal.pct} tone="good" />
            <span>{goal.done} of {goal.target} tasks · {goal.toGo > 0 ? `${goal.toGo} to go` : "reached"}</span>
          </>
        ) : <span className="md-gap">No task goal set yet</span>}
      </div>
    </div>
  );
}

// Points per day this week, one bar a day (Dashboard).
function WeekBars({ d }: { d: MyDayData }) {
  if (!d.weekDays || !d.week) return null;
  const max = Math.max(1, ...d.weekDays.map((x) => x.points));
  const W = 30;
  return (
    <>
      <div className="md-bignum">{Math.round(d.week.points)} <span>points</span></div>
      <svg viewBox={`0 0 ${W * 7} 92`} className="md-weekbars" role="img"
        aria-label={"Points per day this week: " + d.weekDays.filter((x) => !x.future).map((x) => `${x.label} ${Math.round(x.points)}`).join(", ")}>
        <line x1="0" y1="72" x2={W * 7} y2="72" className="md-axis" />
        {d.weekDays.map((x, i) => {
          const h = x.future ? 0 : Math.round((x.points / max) * 62);
          const bx = i * W + 5;
          const top = 72 - h;
          return (
            <g key={x.date}>
              {h > 0 && (
                <path d={`M${bx},72 V${top + Math.min(4, h)} Q${bx},${top} ${bx + Math.min(4, h)},${top} H${bx + 16} Q${bx + 20},${top} ${bx + 20},${top + Math.min(4, h)} V72 Z`}
                  className={"md-weekbar" + (x.isToday ? " today" : "")} />
              )}
              <rect x={i * W} y="0" width={W} height="92" fill="transparent"><title>{`${x.label}: ${x.future ? "still to come" : Math.round(x.points) + " points"}`}</title></rect>
              <text x={bx + 10} y="88" textAnchor="middle" className={"md-weeklabel" + (x.isToday ? " today" : "")}>{x.label.charAt(0)}</text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

// Views on posts published each day this month, as one line (Dashboard).
function ViewsChart({ d }: { d: MyDayData }) {
  const series = d.viewsByDay;
  const max = Math.max(...series.map((s) => s.views), 0);
  if (!series.length || max === 0) return <div className="md-empty">No views on this month's posts yet.</div>;
  const X0 = 44, X1 = 624, Y0 = 16, Y1 = 168;
  const top = niceMax(max);
  const x = (i: number) => (series.length === 1 ? (X0 + X1) / 2 : X0 + (i * (X1 - X0)) / (series.length - 1));
  const y = (v: number) => Y1 - (v / top) * (Y1 - Y0);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.views).toFixed(1)}`).join(" ");
  const last = series[series.length - 1];
  const ticks = [0, top / 2, top];
  return (
    <svg viewBox="0 0 640 196" className="md-viewschart" role="img"
      aria-label={`Views on posts published each day this month, up to ${compactNum(max)} on the best day`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={X0} x2={X1} y1={y(t)} y2={y(t)} className={t === 0 ? "md-axis" : "md-grid"} />
          <text x={X0 - 8} y={y(t) + 4} textAnchor="end" className="md-ticklabel">{compactNum(t)}</text>
        </g>
      ))}
      <path d={`M${x(0)},${Y1} L${pts.split(" ").join(" L")} L${x(series.length - 1)},${Y1} Z`} className="md-area" />
      <polyline points={pts} className="md-line" />
      {series.map((s, i) => (
        <circle key={s.day} cx={x(i)} cy={y(s.views)} r="9" fill="transparent"><title>{`${s.day} ${monthName()}: ${compactNum(s.views)} views`}</title></circle>
      ))}
      <circle cx={x(series.length - 1)} cy={y(last.views)} r="5" className="md-dotmark" />
      <text x={X0} y="190" className="md-ticklabel">1 {monthName()}</text>
      <text x={X1} y="190" textAnchor="end" className="md-ticklabel">{last.day} {monthName()}</text>
    </svg>
  );
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function monthName() {
  return new Date().toLocaleDateString(undefined, { month: "short" });
}

// The editing pipeline as one stacked bar, one shade per stage (Focus, Me and Team).
function PipelineStack({ d }: { d: MyDayData }) {
  const total = STAGES.reduce((a, s) => a + (d.pipeline[s.key] ?? 0), 0);
  if (!total) return <div className="md-empty">No content in the pipeline yet.</div>;
  return (
    <div>
      <div className="md-trow-meta md-gap-b">Editing pipeline · {total} {total === 1 ? "piece" : "pieces"}</div>
      <div className="md-stack" role="img" aria-label={"Pipeline: " + STAGES.map((s) => `${d.pipeline[s.key] ?? 0} ${s.label.toLowerCase()}`).join(", ")}>
        {STAGES.map((s, i) => (d.pipeline[s.key] ?? 0) > 0 && (
          <span key={s.key} className={"md-seg s" + (i + 1)} style={{ flex: d.pipeline[s.key] }} title={`${s.label}: ${d.pipeline[s.key]}`} />
        ))}
      </div>
      <div className="md-legend">
        {STAGES.map((s, i) => (
          <span key={s.key}><span className={"md-swatch s" + (i + 1)} />{s.label} <b>{d.pipeline[s.key] ?? 0}</b></span>
        ))}
      </div>
    </div>
  );
}

// The editing pipeline as one bar per stage (Dashboard).
function PipelineBars({ d }: { d: MyDayData }) {
  const max = Math.max(0, ...STAGES.map((s) => d.pipeline[s.key] ?? 0));
  if (!max) return <div className="md-empty">No content in the pipeline yet.</div>;
  return (
    <div className="md-hbars">
      {STAGES.map((s) => (
        <div key={s.key} className="md-hbar" title={`${s.label}: ${d.pipeline[s.key] ?? 0}`}>
          <span className="md-hbar-label">{s.label}</span>
          <Bar pct={((d.pipeline[s.key] ?? 0) / max) * 100} />
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
      <div><b>{d.loading ? "–" : compactNum(a.views)}</b><span>views</span></div>
      <div><b>{a.engRate == null ? "–" : a.engRate.toFixed(1) + "%"}</b><span>engagement</span></div>
      <div><b>{d.loading ? "–" : a.posts}</b><span>published</span></div>
    </div>
  );
}

function BestPost({ d }: { d: MyDayData }) {
  const p = d.analytics.top;
  return (
    <div className="md-best">
      <div className="md-trow-meta">Best post this month</div>
      {p ? (
        <>
          <div className="md-best-title">{p.title}</div>
          <div className="md-trow-meta">{[p.channel_name, `Score ${formatScore(p)}`, `${compactNum(p.views)} views`, `${compactNum(p.saves)} saves`].filter(Boolean).join(" · ")}</div>
        </>
      ) : <div className="md-trow-meta md-gap">No published posts this month yet.</div>}
    </div>
  );
}

const linkTo = (to: string, label: string) => <Link to={to} className="md-link">{label}</Link>;

// ---------------------------------------------------------------------------
// The three layouts
// ---------------------------------------------------------------------------

type LayoutProps = { d: MyDayData; goal: Goal; onOpen: (id: string) => void; onChanged: () => Promise<unknown> };

function LanesLayout({ d, goal, onOpen, onChanged }: LayoutProps) {
  const { total, frac } = todayFrac(d);
  return (
    <div className="md-lanes">
      <div className="md-lane me">
        <div className="md-lane-head"><h2>Your day</h2><span>What's on your plate and how you're doing</span></div>
        {!d.isAdmin && <CountTiles d={d} compact />}
        {d.linked && (
          <section className="md-card md-band">
            <div className="md-band-progress">
              <div className="md-band-line">{d.completedToday} of {total} tasks done today</div>
              <div className="md-steps" aria-hidden="true">
                {Array.from({ length: Math.min(total, 12) }, (_, i) => (
                  <span key={i} className={i < Math.round(frac * Math.min(total, 12)) ? "on" : undefined} />
                ))}
              </div>
            </div>
            <div className="md-band-stat"><b>{Math.round(d.pointsToday)}</b><span>points today</span></div>
            <div className="md-band-stat"><b>{hoursMins(d.focusSeconds)}</b><span title="Worked out from task time budgets, not tracked exactly">focus, roughly</span></div>
            <div className="md-band-stat"><b>{d.dailyGoalPct == null ? "–" : `${d.dailyGoalPct}%`}</b><span>of daily goal</span></div>
          </section>
        )}
        <Card title="Your tasks" action={linkTo("/tasks", "Open Task Board")}>
          <TaskList d={d} onOpen={onOpen} />
        </Card>
        {d.linked && (
          <Card title="Your score" action={linkTo("/leaderboard", "Leaderboard")}>
            <ScoreTiles d={d} goal={goal} />
          </Card>
        )}
      </div>
      <div className="md-lane team">
        <div className="md-lane-head"><h2>The team</h2><span>{d.isAdmin ? "What needs you as a lead" : "How the team is doing this month"}</span></div>
        {d.isAdmin && <CountTiles d={d} compact />}
        {d.canReview && (
          <Card title="Waiting for your review" id="review">
            <ReviewList d={d} onOpen={onOpen} onChanged={onChanged} stacked />
          </Card>
        )}
        <Card title="This month" action={linkTo("/dashboard", "Dashboard")}>
          <MonthNumbers d={d} />
          <div className="md-divide"><PipelineStack d={d} /></div>
          <div className="md-divide"><BestPost d={d} /></div>
        </Card>
      </div>
    </div>
  );
}

function FocusLayout({ d, goal, onOpen, onChanged }: LayoutProps) {
  return (
    <>
      <CountPills d={d} />
      <div className="md-cols">
        <div className="md-col main">
          <Card title="Up next" sub="Your open tasks, most urgent first" action={linkTo("/tasks", "Open Task Board")}>
            <TaskList d={d} onOpen={onOpen} grouped />
          </Card>
          {d.canReview && (
            <Card title="Waiting for your review" sub="Longest wait first" id="review">
              <ReviewList d={d} onOpen={onOpen} onChanged={onChanged} />
            </Card>
          )}
        </div>
        {d.linked && (
          <div className="md-col side">
            <Card title="Today"><TodayStats d={d} /></Card>
            <Card title="Your score"><ScoreRows d={d} goal={goal} /></Card>
          </div>
        )}
      </div>
      <Card title="The team this month" action={<span className="md-links">{linkTo("/metrics", "Pipeline")}{linkTo("/dashboard", "Dashboard")}</span>}>
        <div className="md-strip">
          <div className="md-strip-pipe"><PipelineStack d={d} /></div>
          <MonthNumbers d={d} />
          <BestPost d={d} />
        </div>
      </Card>
    </>
  );
}

function DashboardLayout({ d, goal, onOpen, onChanged }: LayoutProps) {
  return (
    <>
      <CountTiles d={d} />
      <div className="md-row">
        <TaskTable d={d} onOpen={onOpen} />
        {d.linked && <Card title="Today's progress" className="md-side-card"><TodayStats d={d} big /></Card>}
      </div>
      <div className="md-row">
        {d.canReview && (
          <Card title="Waiting for your review" id="review" className="md-grow">
            <ReviewList d={d} onOpen={onOpen} onChanged={onChanged} />
          </Card>
        )}
        {d.linked && d.week && (
          <Card title="This week" action={<span className="md-badge">{rankText(d.week)}</span>} className="md-side-card">
            <WeekBars d={d} />
          </Card>
        )}
        {d.linked && d.month && (
          <Card title="This month" action={<span className="md-badge">{rankText(d.month)}</span>} className="md-side-card">
            <div className="md-month">
              {goal
                ? <Ring size={96} stroke={10} frac={goal.pct / 100} tone="good" big={`${goal.pct}%`} label={`${goal.done} of ${goal.target} goal tasks done`} />
                : null}
              <div>
                <div className="md-bignum">{Math.round(d.month.points)} <span>points</span></div>
                <div className="md-trow-meta">{goal ? `Goal: ${goal.done} of ${goal.target} tasks · ${goal.toGo > 0 ? `${goal.toGo} to go` : "reached"}` : "No task goal set yet"}</div>
              </div>
            </div>
          </Card>
        )}
      </div>
      <div className="md-row">
        <Card title="Views this month" sub="Views on posts published each day" action={linkTo("/dashboard", "Open Dashboard")} className="md-grow">
          <MonthNumbers d={d} />
          <ViewsChart d={d} />
        </Card>
        <Card title="Editing pipeline" action={linkTo("/metrics", "Open")} className="md-side-card">
          <PipelineBars d={d} />
          <div className="md-divide"><BestPost d={d} /></div>
        </Card>
      </div>
    </>
  );
}

export function MyDayBody({ data, onOpenTask, onChanged }: {
  data: MyDayData; onOpenTask: (id: string) => void; onChanged: () => Promise<unknown>;
}) {
  const [layout, setLayout] = useState<Layout>(readLayout);
  const goal = useMyGoal(data.linked);
  function pick(l: Layout) {
    setLayout(l);
    try { window.localStorage.setItem(LAYOUT_KEY, l); } catch { /* not remembered, still switches */ }
  }
  const props: LayoutProps = { d: data, goal, onOpen: onOpenTask, onChanged };
  return (
    <div className="md-body">
      <div className="md-top">
        {data.hint ? <p className="md-hint">{data.hint}</p> : <span />}
        <div className="md-switch" role="group" aria-label="My Day layout">
          {LAYOUTS.map((l) => (
            <button key={l.key} type="button" aria-pressed={layout === l.key} className={layout === l.key ? "on" : undefined} onClick={() => pick(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {layout === "lanes" && <LanesLayout {...props} />}
      {layout === "focus" && <FocusLayout {...props} />}
      {layout === "dashboard" && <DashboardLayout {...props} />}
    </div>
  );
}
