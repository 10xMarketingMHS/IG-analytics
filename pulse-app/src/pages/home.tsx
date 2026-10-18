import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { useTasks } from "@/lib/use-tasks";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useEodState } from "@/lib/eod-context";
import { useResource } from "@/lib/use-resource";
import { rangeFor, inRange } from "@/lib/date-range";
import { performanceScore } from "@/lib/score";
import { ymd, daysBetween, lateDays, myRankInRange, topEditorsInRange } from "@/lib/task-points";
import { breakOffsetMs, DAILY_BREAK_CAP_SEC, fmtWait, reviewWaitMs } from "@/lib/task-timing";
import { Avatar } from "@/lib/editor-visuals";
import { useReviewAccess, scopeAllowsTask } from "@/lib/use-review-access";
import { TaskPanel } from "@/pages/tasks";
import { MyDayBody, type MyDayData } from "@/pages/my-day-layouts";
import type { Editor, Post, Task } from "@/lib/types";
import { MyReportsModal } from "@/components/my-reports";
import { clockTime } from "@/lib/time-format";

// DF Foods runs a 6-day week (Mon–Sat) — used to spread the monthly Goal Points
// target across the month for the (provisional) Daily Goal pace. Change this one
// constant if the working week changes; it's the only place the assumption lives.
const WORKING_WEEK_OFF_DAY = 0; // Sunday off (0 = Sunday)

function todayStr() {
  return ymd(new Date());
}
function fmtClock(iso: string): string {
  return clockTime(iso);
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
// Working days (Mon–Sat) from today to the end of the month, today included —
// what's left to reach the monthly goal in.
function workingDaysLeft(d: Date): number {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  let n = 0;
  for (let i = d.getDate(); i <= last; i++) {
    if (new Date(d.getFullYear(), d.getMonth(), i).getDay() !== WORKING_WEEK_OFF_DAY) n++;
  }
  return n;
}
// The last 7 dates (YYYY-MM-DD), oldest first, ending today.
function lastSevenDays(): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return ymd(d);
  });
}

// Banner size and whose numbers the page shows — remembered in this browser.
const COMPACT_KEY = "pulse-myday-banner-compact";
const SCOPE_KEY = "pulse-myday-scope";
function readPref(key: string, fallback: string) {
  try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* not remembered, still works */ }
}

// The 7 dates (YYYY-MM-DD) of the current Monday-start week.
function weekDates(): string[] {
  const start = new Date(weekStartStr() + "T00:00:00");
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return ymd(d);
  });
}

// Where each podium chip goes in the banner video, as a share of the frame
// (measured on the 2520×1080 clips): centred over the step's number, just
// above the top of the step. The video fills the banner like
// object-fit: cover, anchored 30% from the top (.mh-video), so the same maths
// finds each step at any banner size.
const PODIUM_STEPS: Record<1 | 2 | 3, [number, number]> = { 1: [0.491, 0.537], 2: [0.281, 0.605], 3: [0.71, 0.621] };
const VIDEO_ASPECT = 2520 / 1080;
type Spot = { x: number; y: number };
function usePodiumSpots(ref: React.RefObject<HTMLDivElement | null>, on: boolean): Record<1 | 2 | 3, Spot> | null {
  const [spots, setSpots] = useState<Record<1 | 2 | 3, Spot> | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) { setSpots(null); return; }
    const fit = () => {
      const W = el.clientWidth, H = el.clientHeight;
      if (!W || !H) return;
      const s = Math.max(W / VIDEO_ASPECT, H);
      const rw = VIDEO_ASPECT * s, rh = s;
      const offX = (W - rw) * 0.5, offY = (H - rh) * 0.3;
      const at = (r: 1 | 2 | 3): Spot => ({ x: offX + PODIUM_STEPS[r][0] * rw, y: offY + PODIUM_STEPS[r][1] * rh });
      setSpots({ 1: at(1), 2: at(2), 3: at(3) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return spots;
}

export function HomePage() {
  const { user } = useAuth();
  const { active, isAdmin, workspaces, hasPermission } = useWorkspaces();
  const { session: eodSession, loading: eodLoading, start: startEod, busy: eodBusy, openSod, openEod } = useEodState();
  const isEditor = active?.role === "editor";
  // My reports (your own SOD and EOD, today and past days) — for anyone on the
  // team roster, admins included.
  const [reportsOpen, setReportsOpen] = useState(false);
  const canReports = !!user?.editorId;
  // Start Work / End Work: anyone on the roster (editors are locked until they
  // start; admins aren't, but can clock in too). Nothing shows while loading.
  const canClock = !!user?.editorId && !eodLoading;
  // A Start Work that fails (no connection, the server down) says so, instead
  // of the button just going back to how it was.
  const startWork = () => startEod().catch((e) => {
    toast.error(e instanceof ApiError ? e.message : "Couldn't start your work day. Check your connection and try again.");
  });
  const reportsLink = canReports && (
    <button type="button" className="mh-reports" onClick={() => setReportsOpen(true)} title="Your Start of Day and End of Day, today and past days">
      {HeroIcon.reports}My reports
    </button>
  );
  const { tasks, refetch: refetchTasks } = useTasks();
  // Tasks in Review that THIS person may resolve: all of them for an admin; for
  // a resolve_tasks grantee, whatever their review scope covers; for an assigner,
  // the tasks they assigned — never their own.
  const review = useReviewAccess();
  const canAssign = isAdmin || hasPermission("assign_tasks");
  const canReview = isAdmin || review.granted || canAssign;
  // The task whose details panel is open (from a review row). Held by id so the
  // panel always shows the freshest copy after a refetch.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = (tasks ?? []).find((t) => t.id === openTaskId) ?? null;
  const reviewQueue = useMemo(
    () => (tasks ?? [])
      .filter((t) => t.status === "review")
      .filter((t) => isAdmin || (t.editor_id !== user?.editorId && (
        (review.granted && scopeAllowsTask(review.scope, t))
        || (canAssign && !!user && t.assigned_by === user.id))))
      // Longest-waiting first — the assignee isn't charged for the wait, but
      // their work is stuck until someone looks at it.
      .sort((a, b) => (a.review_started_at ?? "9999").localeCompare(b.review_started_at ?? "9999")
        || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")),
    [tasks, isAdmin, review, canAssign, user],
  );
  const { editors } = useEditors();
  const { data: postData } = useResource<{ posts: (Post & { channel_name?: string })[] }>("/posts?channel=all");
  // Home is org-wide — collab mirrors never count here (count or performance).
  const posts = postData?.posts?.filter((p) => !p.is_collab_mirror) ?? null;

  const today = todayStr();
  const firstName = (user?.name || user?.email || "").split(" ")[0].split("@")[0];

  // Compact banner: an 84px strip instead of the full hero. Team / Just me: an
  // admin's counts cover the whole team or only their own work; everyone else
  // always sees their own.
  const [compact, setCompact] = useState(() => readPref(COMPACT_KEY, "0") === "1");
  const [scopePref, setScopePref] = useState<"team" | "me">(() => (readPref(SCOPE_KEY, "team") === "me" ? "me" : "team"));
  const teamScope = isAdmin && scopePref === "team";
  const [replay, setReplay] = useState(0);
  const heroRef = useRef<HTMLDivElement>(null);
  const heroFrom = useRef<number | null>(null);
  function toggleCompact() {
    heroFrom.current = heroRef.current?.offsetHeight ?? null;
    setCompact((c) => { writePref(COMPACT_KEY, c ? "0" : "1"); return !c; });
  }
  // Resize the banner smoothly: measure the height it had and the height it
  // lands on, then animate between the two. (A CSS transition can't reach the
  // full banner's natural height, so expanding snapped most of the way first.)
  // The new contents fade in as it opens.
  useLayoutEffect(() => {
    const el = heroRef.current;
    const from = heroFrom.current;
    heroFrom.current = null;
    if (!el || from == null || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.offsetHeight;
    const ease = "cubic-bezier(.2,.8,.2,1)";
    el.animate([{ height: `${from}px`, minHeight: `${from}px` }, { height: `${to}px`, minHeight: `${to}px` }], { duration: 450, easing: ease });
    el.querySelectorAll(compact ? ".mhc" : ".mh-inner, .mh-podium, .mh-compact-btn").forEach((n) => {
      n.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 150, easing: "ease-out", fill: "backwards" });
    });
  }, [compact]);
  function pickScope(s: "team" | "me") {
    setScopePref(s);
    writePref(SCOPE_KEY, s);
  }

  // The greeting + date need an actual clock tick to stay correct — without one,
  // a tab left open across noon/5pm/midnight keeps showing what it computed on
  // the last render, since nothing else on this page re-renders on a schedule.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  const ops = useMemo(() => {
    // My Day is personal for EVERYONE, admins included — each person's own view
    // of what's on their plate, not a team-wide dashboard (the Task Board covers
    // oversight). Someone with no linked roster record simply sees none.
    const scoped = (tasks ?? []).filter((t) => user?.editorId != null && t.editor_id === user.editorId);
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
    // The counts: on Team, an admin's cover the whole team; on Just me (and
    // for everyone who isn't an admin) they cover your own tasks.
    const counted = teamScope ? (tasks ?? []) : scoped;
    const countedOpen = counted.filter((t) => t.status !== "done");
    const overdueList = countedOpen.filter((t) => t.due_date != null && t.due_date < today);
    const dueTodayList = countedOpen.filter((t) => t.due_date === today);

    // Trend lines for the Dashboard counts, worked out from the tasks: how many
    // were overdue / due on each of the last 7 days, and the share of tasks
    // finished on time in the 7 days up to each day.
    const days = lastSevenDays();
    const doneOn = (t: Task) => (t.completed_at ? ymd(new Date(t.completed_at)) : null);
    const overdueSeries = days.map((d) => counted.filter((t) => t.due_date != null && t.due_date < d
      && ymd(new Date(t.created_at)) <= d && (t.status !== "done" || (doneOn(t) ?? "9999") >= d)).length);
    const dueSeries = days.map((d) => counted.filter((t) => t.due_date === d).length);
    const finishedIn = (from: string, to: string) => counted.filter((t) => {
      const d = doneOn(t);
      return t.status === "done" && t.due_date != null && d != null && d >= from && d <= to;
    });
    const rate = (list: Task[]) => (list.length ? Math.round((list.filter((t) => lateDays(t) <= 0).length / list.length) * 100) : null);
    const onTimeSeries = days.map((d) => {
      const from = new Date(d + "T00:00:00");
      from.setDate(from.getDate() - 6);
      return rate(finishedIn(ymd(from), d));
    });
    const monthFinished = finishedIn(monthStartStr(), today);
    return {
      overdue: overdueList.length,
      dueToday: dueTodayList.length,
      // Mine in review (Just me) — the team's waiting count comes from the review queue.
      myInReview: counted.filter((t) => t.status === "review").length,
      openCount: countedOpen.length,
      countedOpen,
      // The line of detail under each count.
      oldestLate: overdueList.reduce((m, t) => Math.max(m, daysBetween(t.due_date!, today)), 0),
      dueTodayStarted: dueTodayList.filter((t) => t.status === "in_progress" || t.status === "review").length,
      overdueSeries, dueSeries, onTimeSeries,
      onTime: { pct: rate(monthFinished), finished: monthFinished.length },
      active, completedToday,
    };
  }, [tasks, today, user?.editorId, teamScope]);

  // ---- Personal Task Points (same formula the Media House Leaders board scores
  // by — see lib/task-points). Today feeds Today's progress; week/month feed
  // Your score. Only meaningful when roster-linked.
  const scoreWindows = useMemo(() => {
    if (!editors || !tasks || !user?.editorId) return null;
    const eid = user.editorId;
    return {
      today: myRankInRange(editors, tasks, today, today, eid),
      week: myRankInRange(editors, tasks, weekStartStr(), today, eid),
      month: myRankInRange(editors, tasks, monthStartStr(), today, eid),
    };
  }, [editors, tasks, today, user?.editorId]);

  // The Media House top 3 this month (same org-scoped Task Points ranking as the
  // leaderboard) — shown as name/points cards over the hero video's podium.
  const podium = useMemo(() => {
    if (!editors || !tasks) return { first: null, second: null, third: null };
    const withEditor = topEditorsInRange(editors, tasks, monthStartStr(), today, 3)
      .map((row) => ({ row, editor: editors.find((e) => e.id === row.editorId) }))
      .filter((x): x is { row: typeof x.row; editor: Editor } => !!x.editor);
    return { first: withEditor[0] ?? null, second: withEditor[1] ?? null, third: withEditor[2] ?? null };
  }, [editors, tasks, today]);

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

  // Points per day this week, for the Dashboard layout's bars.
  const weekDays = useMemo(() => {
    if (!editors || !tasks || !user?.editorId) return null;
    const eid = user.editorId;
    return weekDates().map((date) => ({
      date,
      label: new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }),
      isToday: date === today,
      future: date > today,
      points: date > today ? 0 : myRankInRange(editors, tasks, date, date, eid).points,
    }));
  }, [editors, tasks, today, user?.editorId]);

  // Views on posts published each day this month, day 1 to today.
  const viewsByDay = useMemo(() => {
    const b = rangeFor("thismonth");
    const byDay = new Map<number, number>();
    for (const p of posts ?? []) {
      if (p.status !== "published" || !inRange(p.date, b.from, b.to)) continue;
      const day = Number(p.date.slice(8, 10));
      byDay.set(day, (byDay.get(day) ?? 0) + p.views);
    }
    return Array.from({ length: now.getDate() }, (_, i) => ({ day: i + 1, views: byDay.get(i + 1) ?? 0 }));
  }, [posts, now]);

  const oldestReviewWait = reviewQueue.reduce((m, t) => Math.max(m, reviewWaitMs(t, now.getTime())), 0);
  const avgReviewWait = reviewQueue.length
    ? reviewQueue.reduce((s, t) => s + reviewWaitMs(t, now.getTime()), 0) / reviewQueue.length : 0;
  const waitingOnYou = canReview ? reviewQueue.length : 0;
  const inReviewCount = teamScope ? waitingOnYou : ops.myInReview;
  const myDay: MyDayData = {
    loading,
    today,
    nowMs: now.getTime(),
    isAdmin,
    teamScope,
    openCount: ops.openCount,
    waitingOnYou,
    scopeTasks: ops.countedOpen,
    series: { overdue: ops.overdueSeries, dueToday: ops.dueSeries, onTime: ops.onTimeSeries },
    onTime: ops.onTime,
    avgReviewWait,
    oldestReviewWait,
    workingDaysLeft: workingDaysLeft(now),
    linked: !!user?.editorId,
    hint: user?.editorId ? null
      : active?.role === "viewer" ? "You have view-only access: you can look at tasks, posts and analytics, but not change them."
      : isAdmin ? "You're not on the team roster yet, so nothing personal shows here. Add yourself on Team › Roster (Edit on your own row)."
      : "You're not on the team roster yet, so nothing personal shows here. Ask an admin to link you on Team › Roster.",
    counts: { overdue: ops.overdue, dueToday: ops.dueToday, inReview: inReviewCount, awaitingMetrics },
    countNotes: {
      overdue: ops.overdue ? `Oldest is ${ops.oldestLate} day${ops.oldestLate === 1 ? "" : "s"} late` : "Everything is on time",
      dueToday: ops.dueToday ? `${ops.dueToday - ops.dueTodayStarted} not started` : "Nothing due today",
      inReview: teamScope
        ? (reviewQueue.length ? `Oldest has waited ${fmtWait(oldestReviewWait)}` : "Nothing waiting")
        : (ops.myInReview ? "Waiting on a reviewer" : "Nothing in review"),
      awaitingMetrics: awaitingMetrics ? "Published, no numbers yet" : "Every post has its numbers",
    },
    myTasks: ops.active,
    completedToday: ops.completedToday,
    pointsToday: scoreWindows?.today.points ?? 0,
    focusSeconds,
    dailyGoalPct: dailyGoal?.pct ?? null,
    clockedInSince: eodSession ? fmtClock(eodSession.startedAt) : null,
    week: scoreWindows?.week ?? null,
    month: scoreWindows?.month ?? null,
    weekDays,
    canReview,
    reviewQueue,
    pipeline,
    analytics,
    viewsByDay,
  };

  // One podium chip: the avatar ringed in its medal colour, name and points.
  // Null slot → nothing.
  const podCard = (entry: { row: { points: number }; editor: Editor } | null, rank: 1 | 2 | 3, withRank = false) =>
    entry ? (
      <div className={"mh-pod-card r" + rank} title={`${entry.editor.name}: ${Math.round(entry.row.points)} points this month`}>
        <span className="mh-pod-ava"><Avatar editor={entry.editor} />{withRank && <span className="mh-pod-rank">{rank}</span>}</span>
        <div className="mh-pod-meta">
          <span className="mh-pod-name">{entry.editor.name}</span>
          <span className="mh-pod-pts">{Math.round(entry.row.points).toLocaleString()} pts</span>
        </div>
      </div>
    ) : null;
  const hasPodium = !!(podium.first || podium.second || podium.third);
  const spots = usePodiumSpots(heroRef, hasPodium && !compact);
  const greetText = `${greeting(now)}${firstName ? `, ${firstName}` : ""}`;
  const shortDate = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  // A locked editor's first move is Start Work, in either banner size.
  const locked = isEditor && !eodSession;

  // Team / Just me — only an admin has the team's numbers to switch to.
  const scopeToggle = isAdmin ? (
    <div className="mh-scope" role="group" aria-label="Whose numbers to show">
      {(["team", "me"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={scopePref === s} className={scopePref === s ? "on" : undefined} onClick={() => pickScope(s)}>
          {s === "team" ? "Team" : "Just me"}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <section className="screen myday">
      {/* Hero banner — a shared intro→loop video + text overlay, identical for
          every role. Full size, or a compact strip (remembered per browser). The
          video is decorative; a gradient shows through until the assets are
          present, and a scrim keeps the text legible. */}
      <div ref={heroRef} className={"myday-hero" + (compact ? " compact" : "")}>
        <HeroVideo replay={replay} />
        {/* Two shadings, cross-faded: the full banner's, and the compact strip's. */}
        <div className="mh-scrim" />
        <div className="mh-scrim c" />
        {compact ? (
          <div className="mhc">
            <div className="mhc-brand" aria-hidden="true"><b>Small Tasks</b><b className="g">Big Wins</b></div>
            <span className="mhc-sep" aria-hidden="true" />
            <div className="mhc-main">
              <b>{greetText}</b>
              <span>{shortDate} · {ops.overdue} overdue · {waitingOnYou} waiting on you</span>
            </div>
            {hasPodium && (
              <div className="mhc-podium">
                {podCard(podium.first, 1, true)}{podCard(podium.second, 2, true)}{podCard(podium.third, 3, true)}
              </div>
            )}
            {scopeToggle}
            {canClock && (eodSession ? (
              <>
                <button className="mhc-primary" onClick={() => openEod()} disabled={eodBusy} title="Write today's notes and end your work day">
                  {HeroIcon.stop}<span>{eodBusy ? "Ending…" : "End Work"}</span>
                </button>
                <button className="mhc-ghost mhc-sod" onClick={openSod} title="Copy today's Start of Day report">Start of Day</button>
              </>
            ) : (
              <button className="mhc-primary eod-live" onClick={startWork} disabled={eodBusy} title={locked ? "Start your work day: the menu and your tasks unlock" : "Start your work day"}>
                {HeroIcon.play}<span>{eodBusy ? "Starting…" : "Start Work"}</span>
              </button>
            ))}
            {canReports && (
              <button className="mhc-icon" onClick={() => setReportsOpen(true)} title="My reports — your Start of Day and End of Day" aria-label="My reports">{HeroIcon.reports}</button>
            )}
            <button className="mhc-icon" onClick={toggleCompact} title="Expand banner" aria-label="Expand banner">{HeroIcon.expand}</button>
          </div>
        ) : (
          <>
            <div className="mh-inner">
              <div className="mh-left">
                <h1 className="mh-headline">Small Tasks<br /><span className="mh-headline-g">Big Wins</span></h1>
                <p className="mh-tag">Create. Collaborate. Grow.<br />Level up every day.</p>
                {/* One main button: Start Work before the day starts (kept live in
                    colour by .eod-live while a locked editor's app is grayscaled),
                    End Work once it has, with Start of Day beside it. */}
                {canClock && (eodSession ? (
                  <>
                    <div className="mh-cta-row">
                      <button className="btn btn-primary mh-cta" onClick={() => openEod()} disabled={eodBusy} title="Write today's notes and end your work day">
                        {eodBusy ? "Ending…" : "■ End Work"}
                      </button>
                      {/* Start of Day: today's tasks and the report to copy for WhatsApp. */}
                      <button className="btn mh-endeod" onClick={openSod} title="Copy today's Start of Day report">
                        Start of Day
                      </button>
                    </div>
                    <div className="mh-subline">
                      <span className="mh-clockedin"><i aria-hidden="true" />Clocked in since {fmtClock(eodSession.startedAt)}</span>
                      {reportsLink}
                    </div>
                  </>
                ) : (
                  <div className="mh-startwrap">
                    <button className="btn btn-primary mh-cta eod-live" onClick={startWork} disabled={eodBusy}>
                      {eodBusy ? "Starting…" : "▶ Start Work"}
                    </button>
                    {/* Before Start Work an editor's app is greyed out — say why. */}
                    {locked && <p className="mh-lockhint">Press Start Work to begin your day. Pipeline, Posts, Leaderboard and Goals open once you do.</p>}
                    {reportsLink && <div className="mh-subline">{reportsLink}</div>}
                  </div>
                ))}
              </div>
              <div className="mh-right">
                <div className="mh-date">{dateStr}</div>
                <h2 className="mh-greet">{greetText} 👋</h2>
                <div className="mh-greetsub">Let's make today legendary!</div>
                {scopeToggle}
              </div>
            </div>
            {/* Real Media House top 3 this month, as name/points chips over the
                video's podium (2 left · 1 centre · 3 right). Hidden when nobody has
                scored yet. */}
            {hasPodium && (
              <div className="mh-podium on-steps">
                {spots && ([[podium.first, 1], [podium.second, 2], [podium.third, 3]] as const).map(([entry, rank]) => entry && (
                  <div key={rank} className="mh-pod-spot" style={{ left: spots[rank].x, top: spots[rank].y }}>{podCard(entry, rank)}</div>
                ))}
              </div>
            )}
            {/* Bottom-right corner: replay the intro (a small icon) and fold the banner. */}
            <div className="mh-corner">
              <button className="mh-glass mh-replay-btn" onClick={() => setReplay((n) => n + 1)} title="Replay intro" aria-label="Replay intro">{HeroIcon.replay}</button>
              <button className="mh-glass mh-compact-btn" onClick={toggleCompact} title="Shrink the banner to a strip">{HeroIcon.shrink} Compact</button>
            </div>
          </>
        )}
      </div>

      {/* Everything under the banner: three layouts of the same sections, picked
          by the viewer (see my-day-layouts.tsx). */}
      <MyDayBody data={myDay} onOpenTask={setOpenTaskId} onChanged={refetchTasks} />
      {reportsOpen && <MyReportsModal onClose={() => setReportsOpen(false)} />}
      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite={active?.role !== "viewer"} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => { setOpenTaskId(null); refetchTasks().catch(() => {}); }}
          onChanged={() => { refetchTasks().catch(() => {}); }}
          onCreated={() => {}}
        />
      )}
    </section>
  );
}

// Line icons for the banner's buttons (stroke takes the text colour).
const heroSvg = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const HeroIcon = {
  play: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" fill="currentColor" /></svg>,
  replay: heroSvg("M3 12a9 9 0 1 0 3-6.7M3 4v5h5"),
  shrink: heroSvg("m7 20 5-5 5 5M7 4l5 5 5-5"),
  expand: heroSvg("m7 15 5 5 5-5M7 9l5-5 5 5"),
  stop: <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>,
  reports: heroSvg("M9 3.5h6v3H9zM6.5 5H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 18 5h-.5M9 12h6M9 16h4"),
};

// Hero banner video — an intro clip that plays ONCE per page load, then hands
// off to a loop clip that plays forever. Both muted/inline (autoplay-safe). The
// intro is gated on the boot splash finishing, so on a hard refresh it plays
// AFTER the 10X splash rather than hidden behind it; on in-app navigation (no
// splash) it starts immediately. When the intro ends (or is missing/unplayable)
// the loop is revealed and played from its first frame. If neither asset exists,
// the hero's gradient background shows through. Files:
//   /media/myday-intro.mp4  — plays once, after the boot splash
//   /media/myday-loop.mp4   — loops continuously afterwards
// `replay` going up plays the intro again (the banner's Replay intro button).
function HeroVideo({ replay }: { replay: number }) {
  const [phase, setPhase] = useState<"intro" | "loop">("intro");
  const [introReady, setIntroReady] = useState(false);
  const introRef = useRef<HTMLVideoElement>(null);
  const loopRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!replay) return;
    setPhase("intro");
    const v = introRef.current;
    if (!v) return;
    try {
      v.currentTime = 0;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => setPhase("loop"));
    } catch { setPhase("loop"); }
  }, [replay]);

  // Hand off to the loop clip: reveal it and play from the start. Called when the
  // intro ends, and also if the intro is missing/unplayable so we never stall on
  // a frozen first frame.
  const startLoop = () => {
    setPhase("loop");
    const v = loopRef.current;
    if (v) {
      try {
        v.currentTime = 0;
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch { /* autoplay may be blocked; the gradient still shows */ }
    }
  };

  // Wait for the boot splash before playing the intro. If there's no splash
  // (in-app nav, reduced motion, or it already finished) start right away; a
  // safety timeout guarantees the intro never waits forever.
  useEffect(() => {
    const w = window as unknown as { __pulseBootDone?: boolean };
    if (w.__pulseBootDone || !document.querySelector(".boot-splash")) {
      setIntroReady(true);
      return;
    }
    const on = () => setIntroReady(true);
    window.addEventListener("pulse:bootdone", on, { once: true });
    const t = window.setTimeout(() => setIntroReady(true), 4500);
    return () => { window.removeEventListener("pulse:bootdone", on); window.clearTimeout(t); };
  }, []);

  // Once allowed, play the intro from the top; fall through to the loop if it
  // can't play.
  useEffect(() => {
    if (!introReady || phase !== "intro") return;
    const v = introRef.current;
    if (!v) return;
    try {
      v.currentTime = 0;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(startLoop);
    } catch { startLoop(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introReady, phase]);

  // Both clips stay mounted so the hand-off is a true opacity crossfade — the
  // intro's last frame dissolves into the (already-decoded, already-playing)
  // loop with no gap where the gradient could flash through. The loop sits
  // underneath; the intro fades out on top of it.
  return (
    <>
      <video
        ref={loopRef}
        className="mh-video mh-video-loop"
        muted loop playsInline preload="auto" aria-hidden
        style={{ opacity: phase === "loop" ? 1 : 0 }}
      >
        <source src="/media/myday-loop.mp4" type="video/mp4" />
      </video>
      <video
        ref={introRef}
        className="mh-video mh-video-intro"
        muted playsInline preload="auto" aria-hidden
        onEnded={startLoop}
        onError={startLoop}
        style={{ opacity: phase === "intro" ? 1 : 0 }}
      >
        <source src="/media/myday-intro.mp4" type="video/mp4" />
      </video>
    </>
  );
}
