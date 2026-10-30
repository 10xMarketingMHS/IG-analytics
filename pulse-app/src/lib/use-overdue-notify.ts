import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { popup } from "@/lib/quiet-popups";
import { useAlertGate } from "@/lib/notify-prefs";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { isOverBudget } from "@/lib/task-timing";
import type { Task } from "@/lib/types";

// These alerts all read the app shell's one shared list of open tasks
// (lib/use-task-alerts.ts), checked each time it's re-read — no requests of
// their own.

const NOTIFIED_KEY_PREFIX = "pulse-notified-overdue-";

// A task can only go overdue once per "run" — if it's reassigned or its
// clock restarted (a fresh budget_started_at), that's a new run and it can
// notify again. Keyed by id+start so a reschedule doesn't stay silently
// suppressed forever.
function runKey(t: Task) {
  return `${t.id}:${t.budget_started_at}`;
}

function readNotified(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(NOTIFIED_KEY_PREFIX + userId);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function writeNotified(userId: string, set: Set<string>) {
  try { window.localStorage.setItem(NOTIFIED_KEY_PREFIX + userId, JSON.stringify([...set])); } catch { /* private window */ }
}

// Admin/manager-facing: toasts (bottom-right) whenever a task in the workspace
// runs out of its time budget without being finished — "Priya's reel is 20m
// over, still not done." Unlike the assignee's own new-task toast, this
// deliberately does NOT baseline away pre-existing overdue tasks on first load
// — an admin opening the app should hear about ones that are already overdue,
// not just newly-overdue ones.
export function useOverdueTaskNotify(list: Task[] | null) {
  const { user } = useAuth();
  const { isAdmin } = useWorkspaces();
  const gate = useAlertGate();

  useEffect(() => {
    if (!isAdmin || !user || !list) return;
    // Switched off, or held until working hours (Settings › Notifications).
    if (gate.off("budget") || gate.held()) return;
    const nowMs = Date.now();
    const notified = readNotified(user.id);
    for (const t of list) {
      const key = runKey(t);
      if (notified.has(key)) continue;
      if (!isOverBudget(t, nowMs)) continue;
      popup(() => toast(`⚠️ "${t.title}" is over its time budget`, {
        description: t.editor_name ? `Assigned to ${t.editor_name} — still not done` : "Still not done",
      }));
      notified.add(key);
    }
    writeNotified(user.id, notified);
  }, [list, isAdmin, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

// "A task of mine goes overdue": once a task assigned to you passes its due
// date unfinished, a pop-up — once per task and due date. Overdue alerts still
// show in quiet hours.
const DUE_KEY_PREFIX = "pulse-notified-due-";
export function useDueOverdueNotify(list: Task[] | null) {
  const { user } = useAuth();
  const gate = useAlertGate();

  useEffect(() => {
    if (!user?.editorId || !list) return;
    if (gate.off("overdue")) return;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let seen: Set<string>;
    try { seen = new Set(JSON.parse(window.localStorage.getItem(DUE_KEY_PREFIX + user.id) ?? "[]")); } catch { seen = new Set(); }
    for (const t of list) {
      if (t.editor_id !== user.editorId) continue;
      if (t.status === "done" || !t.due_date || t.due_date >= today) continue;
      const key = `${t.id}:${t.due_date}`;
      if (seen.has(key)) continue;
      popup(() => toast(`⏰ "${t.title}" is overdue`, { description: `It was due ${t.due_date}` }));
      seen.add(key);
    }
    try { window.localStorage.setItem(DUE_KEY_PREFIX + user.id, JSON.stringify([...seen])); } catch { /* private window */ }
  }, [list, user?.editorId, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

// "Work is waiting for my review": for anyone who reviews (an admin, or the
// Resolve reviews permission within its scope) — a pop-up when a task newly
// lands in review. The first look in a browser only takes note of what's
// already there.
const REVIEW_KEY_PREFIX = "pulse-notified-review-";
export function useReviewWaitingNotify(canReview: boolean, allows: (t: Task) => boolean, list: Task[] | null) {
  const { user } = useAuth();
  const gate = useAlertGate();
  const allowsRef = useRef(allows);
  allowsRef.current = allows;

  useEffect(() => {
    if (!canReview || !user || !list) return;
    if (gate.off("review") || gate.held()) return;
    const key = REVIEW_KEY_PREFIX + user.id;
    const first = window.localStorage.getItem(key) === null;
    let seen: Set<string>;
    try { seen = new Set(JSON.parse(window.localStorage.getItem(key) ?? "[]")); } catch { seen = new Set(); }
    const waiting = list.filter((t) => t.status === "review" && t.editor_id !== user.editorId && allowsRef.current(t));
    for (const t of waiting) {
      const k = `${t.id}:${t.review_started_at ?? ""}`;
      if (seen.has(k)) continue;
      if (!first) popup(() => toast(`👀 "${t.title}" is waiting for your review`, { description: t.editor_name ? `From ${t.editor_name}` : undefined }));
      seen.add(k);
    }
    try { window.localStorage.setItem(key, JSON.stringify([...seen])); } catch { /* private window */ }
  }, [list, canReview, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
