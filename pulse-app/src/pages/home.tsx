import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "@/lib/use-tasks";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useEodState } from "@/lib/eod-context";
import { useResource } from "@/lib/use-resource";
import { rangeFor, inRange } from "@/lib/date-range";
import { performanceScore } from "@/lib/score";
import { ymd, daysBetween, myRankInRange, topEditorsInRange } from "@/lib/task-points";
import { breakOffsetMs, DAILY_BREAK_CAP_SEC, fmtWait, reviewWaitMs } from "@/lib/task-timing";
import { Avatar } from "@/lib/editor-visuals";
import { useReviewAccess, scopeAllowsTask } from "@/lib/use-review-access";
import { TaskPanel } from "@/pages/tasks";
import { MyDayBody, type MyDayData } from "@/pages/my-day-layouts";
import type { Editor, Post, Task } from "@/lib/types";

// DF Foods runs a 6-day week (Mon–Sat) — used to spread the monthly Goal Points
// target across the month for the (provisional) Daily Goal pace. Change this one
// constant if the working week changes; it's the only place the assumption lives.
const WORKING_WEEK_OFF_DAY = 0; // Sunday off (0 = Sunday)

function todayStr() {
  return ymd(new Date());
}
function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
// The 7 dates (YYYY-MM-DD) of the current Monday-start week.
function weekDates(): string[] {
  const start = new Date(weekStartStr() + "T00:00:00");
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return ymd(d);
  });
}

export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { active, isAdmin, workspaces, hasPermission } = useWorkspaces();
  const { session: eodSession, start: startEod, busy: eodBusy, openSod, openEod } = useEodState();
  const isEditor = active?.role === "editor";
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
    // The count boxes: an admin oversees everyone, so theirs cover the whole
    // team; everyone else's cover their own tasks.
    const counted = isAdmin ? (tasks ?? []) : scoped;
    const countedOpen = counted.filter((t) => t.status !== "done");
    const overdueList = countedOpen.filter((t) => t.due_date != null && t.due_date < today);
    const dueTodayList = countedOpen.filter((t) => t.due_date === today);
    return {
      overdue: overdueList.length,
      dueToday: dueTodayList.length,
      inReview: counted.filter((t) => t.status === "review").length,
      // The line of detail under each count.
      oldestLate: overdueList.reduce((m, t) => Math.max(m, daysBetween(t.due_date!, today)), 0),
      dueTodayStarted: dueTodayList.filter((t) => t.status === "in_progress" || t.status === "review").length,
      active, completedToday,
    };
  }, [tasks, today, user?.editorId, isAdmin]);

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
  const myDay: MyDayData = {
    loading,
    today,
    nowMs: now.getTime(),
    isAdmin,
    linked: !!user?.editorId,
    hint: user?.editorId ? null
      : active?.role === "viewer" ? "You have view-only access: you can look at tasks, posts and analytics, but not change them."
      : isAdmin ? "You're not on the team roster yet, so nothing personal shows here. Add yourself in Settings → Team (Edit on your own row)."
      : "You're not on the team roster yet, so nothing personal shows here. Ask an admin to link you under Settings → Team.",
    counts: { overdue: ops.overdue, dueToday: ops.dueToday, inReview: ops.inReview, awaitingMetrics },
    countNotes: {
      overdue: ops.overdue ? `Oldest is ${ops.oldestLate} day${ops.oldestLate === 1 ? "" : "s"} late` : "Everything is on time",
      dueToday: ops.dueToday ? `${ops.dueTodayStarted} started, ${ops.dueToday - ops.dueTodayStarted} not yet` : "Nothing due today",
      inReview: canReview && reviewQueue.length
        ? `Oldest has waited ${fmtWait(oldestReviewWait)}`
        : ops.inReview ? "Waiting on a reviewer" : "Nothing waiting",
      awaitingMetrics: awaitingMetrics ? "Published, no numbers yet" : "Every post has its numbers",
    },
    myTasks: ops.active,
    completedToday: ops.completedToday,
    pointsToday: scoreWindows?.today.points ?? 0,
    focusSeconds,
    dailyGoalPct: dailyGoal?.pct ?? null,
    clockedInSince: isEditor && eodSession ? fmtClock(eodSession.startedAt) : null,
    week: scoreWindows?.week ?? null,
    month: scoreWindows?.month ?? null,
    weekDays,
    canReview,
    reviewQueue,
    pipeline,
    analytics,
    viewsByDay,
  };

  // One podium name/points card (gold styling for #1). Null slot → nothing.
  const podCard = (entry: { row: { points: number }; editor: Editor } | null, gold = false) =>
    entry ? (
      <div className={"mh-pod-card" + (gold ? " gold" : "")}>
        <Avatar editor={entry.editor} />
        <div className="mh-pod-meta">
          <span className="mh-pod-name">{entry.editor.name}</span>
          <span className="mh-pod-pts">{Math.round(entry.row.points).toLocaleString()} pts</span>
        </div>
      </div>
    ) : null;

  return (
    <section className="screen myday">
      {/* Hero banner — a shared intro→loop video + text overlay, identical for
          every role. The video is decorative; a gradient shows through until the
          assets are present, and a scrim keeps the text legible. */}
      <div className="myday-hero">
        <HeroVideo />
        <div className="mh-scrim" />
        <div className="mh-inner">
          <div className="mh-left">
            <h1 className="mh-headline">Small Tasks<br /><span className="mh-headline-g">Big Wins</span></h1>
            <p className="mh-tag">Create. Collaborate. Grow.<br />Level up every day.</p>
            {/* Locked editor → the primary slot IS Start Work (kept live in color
                by .eod-live even while the rest of the app is grayscaled). Once
                clocked in, Task Board returns as primary, with End Work secondary. */}
            {isEditor && !eodSession ? (
              <div className="mh-startwrap">
                <button className="btn btn-primary mh-cta eod-live" onClick={() => startEod()} disabled={eodBusy}>
                  {eodBusy ? "Starting…" : "▶ Start Work"}
                </button>
                {/* Before Start Work the rest of the app is greyed out — say why. */}
                <p className="mh-lockhint">Press Start Work to begin your day. The menu and your tasks unlock once you do.</p>
              </div>
            ) : (
              <div className="mh-cta-row">
                <button className="btn btn-primary mh-cta" onClick={() => navigate("/tasks")}>▶ Task Board</button>
                {isEditor && eodSession && (
                  <>
                    <button
                      className="btn mh-endeod"
                      onClick={() => openEod()}
                      title="Write today's notes and end your work day"
                      disabled={eodBusy}
                    >
                      {eodBusy ? "Ending…" : "⏹ End Work"}
                    </button>
                    <span className="mh-clockedin">🟢 Clocked in since {fmtClock(eodSession.startedAt)}</span>
                    {/* Start of Day: today's tasks and the report to copy for WhatsApp. */}
                    <button className="btn mh-endeod" onClick={openSod} title="Copy today's Start of Day report">
                      📋 Start of Day
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="mh-right">
            <div className="mh-date">{dateStr}</div>
            <h2 className="mh-greet">{greeting(now)}{firstName ? `, ${firstName}` : ""} 👋</h2>
            <div className="mh-greetsub">Let's make today legendary!</div>
          </div>
        </div>
        {/* Real Media House top 3 this month, as name/points cards over the
            video's podium (2 left · 1 centre · 3 right). Hidden when nobody has
            scored yet. */}
        {(podium.first || podium.second || podium.third) && (
          <div className="mh-podium">
            <div className="mh-pod-slot">{podCard(podium.second)}</div>
            <div className="mh-pod-slot mh-pod-center">{podCard(podium.first, true)}</div>
            <div className="mh-pod-slot">{podCard(podium.third)}</div>
          </div>
        )}
      </div>

      {/* Everything under the banner: three layouts of the same sections, picked
          by the viewer (see my-day-layouts.tsx). */}
      <MyDayBody data={myDay} onOpenTask={setOpenTaskId} onChanged={refetchTasks} />
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

// Hero banner video — an intro clip that plays ONCE per page load, then hands
// off to a loop clip that plays forever. Both muted/inline (autoplay-safe). The
// intro is gated on the boot splash finishing, so on a hard refresh it plays
// AFTER the 10X splash rather than hidden behind it; on in-app navigation (no
// splash) it starts immediately. When the intro ends (or is missing/unplayable)
// the loop is revealed and played from its first frame. If neither asset exists,
// the hero's gradient background shows through. Files:
//   /media/myday-intro.mp4  — plays once, after the boot splash
//   /media/myday-loop.mp4   — loops continuously afterwards
function HeroVideo() {
  const [phase, setPhase] = useState<"intro" | "loop">("intro");
  const [introReady, setIntroReady] = useState(false);
  const introRef = useRef<HTMLVideoElement>(null);
  const loopRef = useRef<HTMLVideoElement>(null);

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
