import { useEffect, useMemo, useState } from "react";
import { Loader } from "@/components/loader";
import { Link, useNavigate } from "react-router-dom";
import { useTasks } from "@/lib/use-tasks";
import { useAuth } from "@/lib/auth-context";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { rangeFor, inRange, compactNum } from "@/lib/date-range";
import { performanceScore, formatScore } from "@/lib/score";
import { ymd, myRankInRange } from "@/lib/task-points";
import { breakOffsetMs, DAILY_BREAK_CAP_SEC } from "@/lib/task-timing";
import { goalBreakdown, DISCIPLINE_CRITERIA, type Ratings } from "@/lib/goal-points";
import { quoteOfDay } from "@/lib/quotes";
import { api } from "@/lib/api";
import { TopPerformerTicker } from "@/components/top-performer-ticker";
import type { Post, Task, TaskStatus, TaskType } from "@/lib/types";

// DF Foods runs a 6-day week (Mon–Sat) — used to spread the monthly Goal Points
// target across the month for the (provisional) Daily Goal pace. Change this one
// constant if the working week changes; it's the only place the assumption lives.
const WORKING_WEEK_OFF_DAY = 0; // Sunday off (0 = Sunday)

function todayStr() {
  return ymd(new Date());
}
function greeting(now: Date) {
  const h = now.getHours();
  // Midnight-to-5am shouldn't say "Good morning" — nobody wants that at 1am.
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
// Monday-start of the current calendar week, as YYYY-MM-DD.
function weekStartStr() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return ymd(d);
}
function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
// Working days (Mon–Sat) in the given date's month — the denominator for the
// provisional Daily Goal pace.
function workingDaysInMonth(d: Date): number {
  const y = d.getFullYear();
  const mo = d.getMonth();
  const days = new Date(y, mo + 1, 0).getDate();
  let n = 0;
  for (let i = 1; i <= days; i++) {
    if (new Date(y, mo, i).getDay() !== WORKING_WEEK_OFF_DAY) n++;
  }
  return n;
}
function hoursMins(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// A little extra flair once someone's actually on top of a board.
const RANK_BADGE: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

// Today's Tasks — status filter pills (the active statuses; "done" is excluded
// from this list entirely, it's the working queue).
const STATUS_PILLS: { key: "all" | TaskStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: "Not Started" },
  { key: "in_progress", label: "In Progress" },
  { key: "review", label: "In Review" },
];
// Tag chip colour by task type (the visible label prefers the content-format
// name — Reels/Poster/etc. — falling back to this generic type label).
const TAG_META: Record<TaskType, { label: string; cls: string }> = {
  content: { label: "Content", cls: "t-content" },
  short_task: { label: "Quick", cls: "t-quick" },
  general: { label: "General", cls: "t-general" },
  social: { label: "Social", cls: "t-social" },
  ad: { label: "Ad", cls: "t-ad" },
  admin: { label: "Admin", cls: "t-admin" },
  service: { label: "Service", cls: "t-service" },
};

const STAGE_META: Record<string, { label: string; cls: string }> = {
  not_started: { label: "Not Started", cls: "ns" },
  in_progress: { label: "In Progress", cls: "ip" },
  in_review: { label: "In Review", cls: "ir" },
  pending: { label: "Pending", cls: "pd" },
  completed: { label: "Completed", cls: "cp" },
};

export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { tasks } = useTasks();
  const { editors } = useEditors();
  const { data: postData } = useResource<{ posts: (Post & { channel_name?: string })[] }>("/posts?channel=all");
  // Home is org-wide — collab mirrors never count here (count or performance).
  const posts = postData?.posts?.filter((p) => !p.is_collab_mirror) ?? null;

  const today = todayStr();
  const firstName = (user?.name || user?.email || "").split(" ")[0].split("@")[0];

  // The greeting + date need an actual clock tick to stay correct — without one,
  // a tab left open across noon/5pm/midnight keeps showing what it computed on
  // the last render, since nothing else on this page re-renders on a schedule.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const quote = quoteOfDay(now);

  const ops = useMemo(() => {
    // My Day is personal for EVERYONE, admins included — each person's own view
    // of what's on their plate, not a team-wide dashboard (the Task Board covers
    // oversight). Someone with no linked roster record simply sees none.
    const scoped = (tasks ?? []).filter((t) => user?.editorId != null && t.editor_id === user.editorId);
    const open = scoped.filter((t) => t.status !== "done" && t.due_date);
    const overdue = open.filter((t) => (t.due_date as string) < today);
    const dueToday = open.filter((t) => t.due_date === today);
    // The working queue for Today's Tasks — everything not done, newest-relevant
    // first (overdue/today ahead of the rest, then by due date).
    const active = scoped
      .filter((t) => t.status !== "done")
      .sort((a, b) => {
        const ad = a.due_date ?? "9999";
        const bd = b.due_date ?? "9999";
        return ad.localeCompare(bd);
      });
    const completedToday = scoped.filter((t) => t.completed_at && ymd(new Date(t.completed_at)) === today).length;
    return { overdue: overdue.length, dueToday: dueToday.length, active, completedToday };
  }, [tasks, today, user?.editorId]);

  // ---- Personal Task Points (same formula the Media House Leaders board scores
  // by — see lib/task-points). Today feeds Today's Progress; week/month feed the
  // cards below and the rank character. Only meaningful when roster-linked.
  const scoreWindows = useMemo(() => {
    if (!editors || !tasks || !user?.editorId) return null;
    const eid = user.editorId;
    return {
      today: myRankInRange(editors, tasks, today, today, eid),
      week: myRankInRange(editors, tasks, weekStartStr(), today, eid),
      month: myRankInRange(editors, tasks, monthStartStr(), today, eid),
    };
  }, [editors, tasks, today, user?.editorId]);
  const monthRank = scoreWindows?.month.rank ?? null;

  // Focus time today — a derived approximation (there is no stored focus metric):
  // the sum of each of the viewer's tasks' budget-clock time that elapsed TODAY
  // (budget_started_at → completed_at/now), minus the day's break time. Labeled
  // approximate on purpose.
  const focusSeconds = useMemo(() => {
    if (!tasks || !user?.editorId) return 0;
    const eid = user.editorId;
    const nowMs = now.getTime();
    const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let ms = 0;
    let breakSec = 0;
    let onBreakTask: Task | null = null;
    for (const t of tasks) {
      if (t.editor_id !== eid) continue;
      breakSec = Math.max(breakSec, t.editor_break_used_seconds ?? 0);
      if (t.editor_break_started_at) onBreakTask = t;
      if (!t.budget_started_at) continue;
      const start = Math.max(new Date(t.budget_started_at).getTime(), todayStartMs);
      const end = Math.min(t.completed_at ? new Date(t.completed_at).getTime() : nowMs, nowMs);
      if (end > start) ms += end - start;
    }
    // Break time is shared across the editor's tasks — subtract it once. If a
    // break is running right now, use the live offset (used + current elapsed).
    if (onBreakTask) breakSec = Math.min(DAILY_BREAK_CAP_SEC, breakOffsetMs(onBreakTask, nowMs) / 1000);
    return Math.max(0, Math.round(ms / 1000 - breakSec));
  }, [tasks, user?.editorId, now]);

  // Daily Goal pace (PROVISIONAL — no daily target exists in the product; this
  // spreads the month's Goal Points across working days as a stand-in). Needs a
  // real definition before it's treated as settled.
  const { data: goalTotals } = useResource<{ totals: { editorId: string; goalPoints: number }[] }>(
    `/goals/totals?month=${monthStartStr()}`,
  );
  const dailyGoal = useMemo(() => {
    const mine = goalTotals?.totals.find((t) => t.editorId === user?.editorId);
    const monthGoal = mine?.goalPoints ?? 0;
    if (!monthGoal || !scoreWindows) return null;
    const target = monthGoal / workingDaysInMonth(now);
    if (target <= 0) return null;
    const pct = Math.max(0, Math.round((scoreWindows.today.points / target) * 100));
    return { pct, target };
  }, [goalTotals, user?.editorId, scoreWindows, now]);

  const pipeline = useMemo(() => {
    const c: Record<string, number> = { not_started: 0, in_progress: 0, in_review: 0, pending: 0, completed: 0 };
    for (const p of posts ?? []) c[p.edit_stage] = (c[p.edit_stage] ?? 0) + 1;
    return c;
  }, [posts]);

  const awaitingMetrics = useMemo(
    () => (posts ?? []).filter((p) => p.status === "published" && p.reach === 0).length,
    [posts],
  );

  const analytics = useMemo(() => {
    const b = rangeFor("thismonth");
    const pub = (posts ?? []).filter((p) => p.status === "published" && inRange(p.date, b.from, b.to));
    const views = pub.reduce((a, p) => a + p.views, 0);
    const reach = pub.reduce((a, p) => a + p.reach, 0);
    const eng = pub.reduce((a, p) => a + p.likes + p.comments + p.shares + p.saves, 0);
    const top = [...pub].sort((a, b) => performanceScore(b) - performanceScore(a))[0];
    return { views, posts: pub.length, engRate: reach ? (eng / reach) * 100 : null, top };
  }, [posts]);

  const loading = tasks === null || posts === null;
  const pipelineTotal = Object.values(pipeline).reduce((a, b) => a + b, 0);

  const STATS: { label: string; value: number; tone: string; to: string; icon: string }[] = [
    { label: "Overdue tasks", value: ops.overdue, tone: "danger", to: "/tasks", icon: "⏰" },
    { label: "Due today", value: ops.dueToday, tone: "warn", to: "/tasks", icon: "📅" },
    { label: "Awaiting metrics", value: awaitingMetrics, tone: "accent", to: "/posts", icon: "📊" },
    { label: "In review", value: pipeline.in_review, tone: "info", to: "/metrics", icon: "👁️" },
  ];

  return (
    <section className="screen myday">
      {/* Top Performer of the Month — celebratory ticker above everything. */}
      <TopPerformerTicker />

      {/* Hero banner — one shared looping video + text overlay, identical for
          every role. The video is decorative; a gradient shows through until
          the asset (/media/myday-banner.mp4) is present, and a scrim keeps the
          text legible whatever the video is doing. */}
      <div className="myday-hero">
        <video className="mh-video" autoPlay muted loop playsInline preload="auto" aria-hidden>
          <source src="/media/myday-banner.mp4" type="video/mp4" />
        </video>
        <div className="mh-scrim" />
        <div className="mh-inner">
          <div className="mh-left">
            <h1 className="mh-headline">Small Tasks<br /><span className="mh-headline-g">Big Wins</span></h1>
            <p className="mh-tag">Create. Collaborate. Grow.<br />Level up every day.</p>
            <button className="btn btn-primary mh-cta" onClick={() => navigate("/tasks")}>▶ New Task</button>
          </div>
          <div className="mh-right">
            <div className="mh-date">{dateStr}</div>
            <h2 className="mh-greet">{greeting(now)}{firstName ? `, ${firstName}` : ""} 👋</h2>
            <div className="mh-greetsub">Let's make today legendary!</div>
            <div className="mh-quote"><span className="mh-quote-i">👑</span><i>"{quote}"</i></div>
          </div>
        </div>
      </div>

      {!user?.editorId && (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
          Your account isn't linked to a team member yet, so My Day and your score have nothing personal to show.
          Ask an admin to link you under Settings → Team.
        </div>
      )}

      {/* Attention strip — same four metrics, restyled (icon chip + left rail). */}
      <div className="myday-stats">
        {STATS.map((s) => (
          <button key={s.label} className={"myday-stat " + s.tone} onClick={() => navigate(s.to)}>
            <span className="ms-ic">{s.icon}</span>
            <span className="ms-body">
              <span className="ms-v">{loading ? "—" : s.value}</span>
              <span className="ms-l">{s.label}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Today's Tasks + Today's Progress */}
      <div className="myday-grid2">
        <TodaysTasks tasks={ops.active} loading={loading} navigate={navigate} />
        {scoreWindows && (
          <TodaysProgress
            completedToday={ops.completedToday}
            openCount={ops.active.length}
            pointsToday={scoreWindows.today.points}
            focusSeconds={focusSeconds}
            dailyGoalPct={dailyGoal?.pct ?? null}
            monthRank={monthRank}
          />
        )}
      </div>

      {/* This Week · This Month · Achievements */}
      {scoreWindows && (
        <div className="myday-grid3">
          <ScoreCard icon="🎯" title="This Week" window={scoreWindows.week} />
          <ScoreCard icon="👑" title="This Month" window={scoreWindows.month} />
          <AchievementsCard />
        </div>
      )}

      <MyGoalScore />

      {/* Existing operational + analytics detail — kept below the redesigned
          personal panels (no mockup equivalent, still useful). */}
      <div className="home-cols">
        <div className="home-col">
          <div className="home-colhead" style={{ marginTop: 6 }}>
            <span className="hc-tag ops">Pipeline</span><h3>Editing progress</h3>
            <Link to="/metrics" className="hc-link">Open →</Link>
          </div>
          <div className="card pad">
            {pipelineTotal === 0 ? (
              <div className="home-empty">No content in the pipeline yet.</div>
            ) : (
              <>
                <div className="pipe-bar">
                  {(["completed", "in_review", "pending", "in_progress", "not_started"] as const).map((k) =>
                    pipeline[k] > 0 ? (
                      <div key={k} className={"pipe-seg " + STAGE_META[k].cls}
                        style={{ flex: pipeline[k] }} title={`${STAGE_META[k].label}: ${pipeline[k]}`} />
                    ) : null,
                  )}
                </div>
                <div className="pipe-legend">
                  {(["not_started", "in_progress", "in_review", "pending", "completed"] as const).map((k) => (
                    <span key={k} className="pipe-leg"><span className={"pipe-dot " + STAGE_META[k].cls} />{STAGE_META[k].label} <b>{pipeline[k]}</b></span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="home-col">
          <div className="home-colhead" style={{ marginTop: 6 }}><span className="hc-tag ana">Analytics</span><h3>This month</h3>
            <Link to="/dashboard" className="hc-link">Dashboard →</Link>
          </div>
          <div className="grid g2" style={{ gap: 14 }}>
            <div className="card kpi"><div className="ic">👁️</div><div className="l">Total Views</div><div className="v">{loading ? "—" : compactNum(analytics.views)}</div><div className="d flat">{analytics.posts} published</div></div>
            <div className="card kpi"><div className="ic">⚡</div><div className="l">Engagement Rate</div><div className="v">{analytics.engRate == null ? "—" : analytics.engRate.toFixed(1) + "%"}</div><div className="d flat">of accounts reached</div></div>
          </div>

          <div className="home-colhead" style={{ marginTop: 22 }}>
            <span className="hc-tag ana">Top mover</span><h3>Best post this month</h3>
          </div>
          <div className="card pad">
            {loading ? (
              <Loader label="Loading…" />
            ) : analytics.top ? (
              <div className="topmover">
                <div className="tm-rank">🥇</div>
                <div className="tm-main">
                  <div className="tm-title">{analytics.top.title}</div>
                  <div className="tm-meta">{(analytics.top as Post & { channel_name?: string }).channel_name ?? ""}</div>
                  <div className="tm-stats">
                    <span>Score <b>{formatScore(analytics.top)}</b></span>
                    <span>Views <b>{compactNum(analytics.top.views)}</b></span>
                    <span>Saves <b>{compactNum(analytics.top.saves)}</b></span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="home-empty">No published posts this month yet.</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- Today's Tasks: the viewer's working queue with status pills, format tag
// chips and per-task point values (the base points the format is worth). ----
function TodaysTasks({ tasks, loading, navigate }: { tasks: Task[]; loading: boolean; navigate: (to: string) => void }) {
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.length, todo: 0, in_progress: 0, review: 0 };
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);
  const shown = filter === "all" ? tasks : tasks.filter((t) => t.status === filter);

  return (
    <div className="card myday-panel">
      <div className="mp-head">
        <h3><span className="mp-ic">🗂️</span> Today's Tasks</h3>
        <Link to="/tasks" className="mp-link">View all →</Link>
      </div>
      <div className="tt-pills">
        {STATUS_PILLS.map((p) => (
          <button
            key={p.key}
            className={"tt-pill" + (filter === p.key ? " active" : "")}
            onClick={() => setFilter(p.key)}
          >
            {p.label}<span className="tt-pill-n">{counts[p.key] ?? 0}</span>
          </button>
        ))}
      </div>
      {loading ? (
        <Loader label="Loading…" />
      ) : shown.length === 0 ? (
        <div className="home-empty">🎉 Nothing here — you're all caught up.</div>
      ) : (
        <div className="tt-list">
          {shown.slice(0, 8).map((t) => {
            const tag = TAG_META[t.task_type] ?? TAG_META.general;
            const tagLabel = t.content_format_name || tag.label;
            const pts = t.content_format_points != null ? Number(t.content_format_points) : 1;
            return (
              <button key={t.id} className="tt-row" onClick={() => navigate("/tasks")}>
                <span className="tt-check" aria-hidden />
                <span className="tt-main">
                  <span className="tt-title">{t.title}</span>
                  <span className={"tt-tag " + tag.cls}>{tagLabel}</span>
                </span>
                <span className="tt-pts">+{pts} pts</span>
                <span className="tt-go">›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Today's Progress: completion ring + points/focus/daily-goal stats, with
// the rank character shown only for the current month's top 3. ----
function TodaysProgress({
  completedToday, openCount, pointsToday, focusSeconds, dailyGoalPct, monthRank,
}: {
  completedToday: number; openCount: number; pointsToday: number;
  focusSeconds: number; dailyGoalPct: number | null; monthRank: number | null;
}) {
  const total = completedToday + openCount;
  const frac = total > 0 ? completedToday / total : 0;
  const R = 52;
  const C = 2 * Math.PI * R;

  return (
    <div className="card myday-panel tp-panel">
      <div className="mp-head">
        <h3><span className="mp-ic">🌱</span> Today's Progress</h3>
        {monthRank && monthRank <= 3 && <span className="tp-rankbadge">#{monthRank}</span>}
      </div>
      <div className="tp-body">
        <div className="tp-left">
          <div className="tp-ring">
            <svg viewBox="0 0 120 120" aria-hidden>
              <circle cx="60" cy="60" r={R} className="tp-ring-bg" />
              <circle
                cx="60" cy="60" r={R} className="tp-ring-fg"
                strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
                transform="rotate(-90 60 60)"
              />
            </svg>
            <div className="tp-ring-c">
              <b>{completedToday}<span>/{total}</span></b>
              <small>tasks done</small>
            </div>
          </div>
          <div className="tp-stats">
            <div className="tp-stat"><span className="tp-si">⭐</span><span><b>{Math.round(pointsToday)}</b><small>Points today</small></span></div>
            <div className="tp-stat"><span className="tp-si">⚡</span><span><b>{hoursMins(focusSeconds)}</b><small>Focus time <i title="Approximate — derived from task time budgets, not a tracked metric.">≈</i></small></span></div>
            <div className="tp-stat"><span className="tp-si">🎯</span><span><b>{dailyGoalPct == null ? "—" : dailyGoalPct + "%"}</b><small>Daily goal{dailyGoalPct != null ? <i title="Provisional: today's points vs the month's goal spread across working days."> *</i> : ""}</small></span></div>
          </div>
        </div>
        <RankCharacter rank={monthRank} />
      </div>
      {dailyGoalPct != null && (
        <div className="tp-goalbar">
          <div className="tp-goalbar-fill" style={{ width: `${Math.min(100, dailyGoalPct)}%` }} />
        </div>
      )}
    </div>
  );
}

// The rank illustration — only rendered for the current month's top 3, and only
// if the matching asset actually exists. Anything else (unranked, or a missing
// PNG) collapses to nothing so the stats fill the panel cleanly.
function RankCharacter({ rank }: { rank: number | null }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [rank]);
  if (!rank || rank > 3 || broken) return null;
  return (
    <div className="tp-char">
      <img src={`/media/rank-${rank}.png`} alt={`Rank ${rank} character`} width={600} height={800} decoding="async" onError={() => setBroken(true)} />
    </div>
  );
}

// ---- This Week / This Month score cards (same windows the score strip used). --
function ScoreCard({ icon, title, window: w }: { icon: string; title: string; window: ReturnType<typeof myRankInRange> }) {
  const pct = w.rank ? Math.max(6, Math.round((1 - (w.rank - 1) / Math.max(1, w.totalRanked)) * 100)) : 0;
  return (
    <div className="card myday-scorecard">
      <div className="msc-head"><span className="msc-ic">{icon}</span>{title}<Link to="/leaderboard" className="msc-link">View →</Link></div>
      <div className="msc-body">
        <div>
          <div className="msc-pts">{w.points.toFixed(1)} <span>pts</span></div>
          <div className="msc-sub">{w.rank ? `of ${w.totalRanked} scoring` : "no points yet"}</div>
        </div>
        <div className="msc-rank">{w.rank ? (RANK_BADGE[w.rank] ?? `#${w.rank}`) : "—"}</div>
      </div>
      <div className="msc-bar"><div className="msc-bar-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// ---- Achievements: no unlock system exists yet — every badge stays locked. ----
function AchievementsCard() {
  return (
    <div className="card myday-scorecard ach">
      <div className="msc-head"><span className="msc-ic">🏆</span>Achievements</div>
      <div className="ach-row">
        {["⚡", "🎬", "🏆", "🔒"].map((b, i) => (
          <span key={i} className="ach-badge locked">{b}</span>
        ))}
      </div>
      <div className="ach-note">Complete more tasks to unlock new badges!</div>
    </div>
  );
}

// The signed-in editor's own monthly goal score (Earned 80% + Discipline 20% =
// Overall) — read-only, current month, their figures only. Hidden when they
// have no linked editor record or no goals set this month.
function currentMonthFirst(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function MyGoalScore() {
  const { user } = useAuth();
  const [data, setData] = useState<{ rows: { goalJC: number; actualJC: number; points: number }[]; ratings: Ratings } | null>(null);
  useEffect(() => {
    if (!user?.editorId) return;
    api<{ rows: { goalJC: number; actualJC: number; points: number }[]; ratings: Ratings }>(`/goals/my-breakdown?month=${currentMonthFirst()}`)
      .then((d) => setData(d))
      .catch(() => {});
  }, [user?.editorId]);
  if (!user?.editorId || !data) return null;
  const bd = goalBreakdown(data.rows, data.ratings ?? {});
  if (!bd) return null; // no goals assigned this month
  const w = (n: number) => Math.round(n);
  return (
    <>
      <div className="home-colhead" style={{ marginTop: 4 }}>
        <span className="hc-tag ops">This month</span><h3>Your goal score</h3>
      </div>
      <div className="home-stats" style={{ marginBottom: 10 }}>
        <div className="home-stat accent"><div className="hs-v">{w(bd.earned)}</div><div className="hs-l">Earned (80%)</div></div>
        <div className="home-stat info"><div className="hs-v">{w(bd.discipline)}{!bd.reviewed ? "*" : ""}</div><div className="hs-l">Discipline (20%)</div></div>
        <div className="home-stat"><div className="hs-v">{w(bd.overall)}</div><div className="hs-l">Overall / {w(bd.total)}</div></div>
      </div>
      {/* The 5 criteria behind the discipline number — "where did I lose points". */}
      <div className="card pad" style={{ marginBottom: 18, display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5 }}>
        {DISCIPLINE_CRITERIA.map((c) => {
          const v = data.ratings?.[c.key];
          return (
            <span key={c.key}>{c.label}: <b>{v == null ? "5" : v}</b>/5{v == null ? <span className="st dim"> (default)</span> : ""}</span>
          );
        })}
        {!bd.reviewed && <span className="st dim">* not yet fully reviewed</span>}
      </div>
    </>
  );
}
