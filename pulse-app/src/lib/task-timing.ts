import type { Task } from "@/lib/types";

// Shared between the Task Board's countdown display (tasks.tsx) and the
// admin overdue-task notifier (use-overdue-notify.ts) so both agree on
// exactly when a task's clock is actually paused vs. genuinely over.

// How long the assignee's break has paused their timers by, right now — the
// used-so-far total, plus (if currently on break) however much of the
// current break has elapsed, capped at what's left of the daily allowance.
// Mirrors the same lazy-auto-expiry math as server/src/routes/breaks.js so
// the countdown never runs ahead of what the server will eventually settle
// on, even before an explicit resume.
export const DAILY_BREAK_CAP_SEC = 75 * 60;

export function breakOffsetMs(t: Task, nowMs: number): number {
  const used = t.editor_break_used_seconds ?? 0;
  let extra = 0;
  if (t.editor_break_started_at) {
    const startMs = new Date(t.editor_break_started_at).getTime();
    const remainingCap = Math.max(0, DAILY_BREAK_CAP_SEC - used);
    extra = Math.min(Math.max(0, (nowMs - startMs) / 1000), remainingCap);
  }
  return (used + extra) * 1000;
}

// True once a task's time budget has actually run out — accepted, has a
// budget, its clock has started, break time already netted out, and it
// isn't done.
export function isOverBudget(t: Task, nowMs: number): boolean {
  if (!t.accepted || t.budget_hours == null || !t.budget_started_at || t.status === "done") return false;
  const startMs = new Date(t.budget_started_at).getTime();
  if (startMs > nowMs) return false; // scheduled to start later — not running yet
  const deadlineMs = startMs + t.budget_hours * 3_600_000 + breakOffsetMs(t, nowMs);
  return deadlineMs < nowMs;
}
