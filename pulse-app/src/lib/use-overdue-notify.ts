import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAlertGate } from "@/lib/notify-prefs";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { api } from "@/lib/api";
import { isOverBudget } from "@/lib/task-timing";
import type { Task } from "@/lib/types";

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
  window.localStorage.setItem(NOTIFIED_KEY_PREFIX + userId, JSON.stringify([...set]));
}

// Admin/manager-facing: polls every task in the workspace and toasts
// (bottom-right) whenever one runs out of its time budget without being
// finished — "Priya's reel is 20m over, still not done." Unlike the
// assignee's own new-task toast, this deliberately does NOT baseline away
// pre-existing overdue tasks on first load — an admin opening the app should
// hear about ones that are already overdue, not just newly-overdue ones.
export function useOverdueTaskNotify() {
  const { user } = useAuth();
  const { isAdmin } = useWorkspaces();
  const gate = useAlertGate();

  useEffect(() => {
    if (!isAdmin || !user) return;
    let cancelled = false;

    async function poll() {
      try {
        // Switched off, or held until working hours (Settings › Notifications).
        if (gate.off("budget") || gate.held()) return;
        const { tasks } = await api<{ tasks: Task[] }>("/tasks");
        if (cancelled) return;
        const nowMs = Date.now();
        const notified = readNotified(user!.id);
        for (const t of tasks) {
          const key = runKey(t);
          if (notified.has(key)) continue;
          if (!isOverBudget(t, nowMs)) continue;
          toast(`⚠️ "${t.title}" is over its time budget`, {
            description: t.editor_name ? `Assigned to ${t.editor_name} — still not done` : "Still not done",
          });
          notified.add(key);
        }
        writeNotified(user!.id, notified);
      } catch {
        // Background nicety — stay silent on failure, next poll retries.
      }
    }

    poll();
    const id = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAdmin, user?.id]);
}

// "A task of mine goes overdue": once a task assigned to you passes its due
// date unfinished, a pop-up — once per task and due date. Overdue alerts still
// show in quiet hours.
const DUE_KEY_PREFIX = "pulse-notified-due-";
export function useDueOverdueNotify() {
  const { user } = useAuth();
  const gate = useAlertGate();

  useEffect(() => {
    if (!user?.editorId) return;
    let cancelled = false;
    async function poll() {
      try {
        if (gate.off("overdue")) return;
        const { tasks } = await api<{ tasks: Task[] }>("/tasks?assignee=me");
        if (cancelled) return;
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        let seen: Set<string>;
        try { seen = new Set(JSON.parse(window.localStorage.getItem(DUE_KEY_PREFIX + user!.id) ?? "[]")); } catch { seen = new Set(); }
        for (const t of tasks) {
          if (t.status === "done" || !t.due_date || t.due_date >= today) continue;
          const key = `${t.id}:${t.due_date}`;
          if (seen.has(key)) continue;
          toast(`⏰ "${t.title}" is overdue`, { description: `It was due ${t.due_date}` });
          seen.add(key);
        }
        try { window.localStorage.setItem(DUE_KEY_PREFIX + user!.id, JSON.stringify([...seen])); } catch { /* private window */ }
      } catch {
        // Background nicety — stay silent on failure, next poll retries.
      }
    }
    poll();
    const id = setInterval(poll, 5 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user?.editorId, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

// "Work is waiting for my review": for anyone who reviews (an admin, or the
// Resolve reviews permission within its scope) — a pop-up when a task newly
// lands in review. The first poll in a browser only takes note of what's
// already there.
const REVIEW_KEY_PREFIX = "pulse-notified-review-";
export function useReviewWaitingNotify(canReview: boolean, allows: (t: Task) => boolean) {
  const { user } = useAuth();
  const gate = useAlertGate();
  const allowsRef = useRef(allows);
  allowsRef.current = allows;

  useEffect(() => {
    if (!canReview || !user) return;
    let cancelled = false;
    async function poll() {
      try {
        if (gate.off("review") || gate.held()) return;
        const { tasks } = await api<{ tasks: Task[] }>("/tasks");
        if (cancelled) return;
        const key = REVIEW_KEY_PREFIX + user!.id;
        const first = window.localStorage.getItem(key) === null;
        let seen: Set<string>;
        try { seen = new Set(JSON.parse(window.localStorage.getItem(key) ?? "[]")); } catch { seen = new Set(); }
        const waiting = tasks.filter((t) => t.status === "review" && t.editor_id !== user!.editorId && allowsRef.current(t));
        for (const t of waiting) {
          const k = `${t.id}:${t.review_started_at ?? ""}`;
          if (seen.has(k)) continue;
          if (!first) toast(`👀 "${t.title}" is waiting for your review`, { description: t.editor_name ? `From ${t.editor_name}` : undefined });
          seen.add(k);
        }
        try { window.localStorage.setItem(key, JSON.stringify([...seen])); } catch { /* private window */ }
      } catch {
        // Background nicety — stay silent on failure, next poll retries.
      }
    }
    poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [canReview, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
