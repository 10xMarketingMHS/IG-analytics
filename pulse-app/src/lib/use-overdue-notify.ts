import { useEffect } from "react";
import { toast } from "sonner";
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

  useEffect(() => {
    if (!isAdmin || !user) return;
    let cancelled = false;

    async function poll() {
      try {
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
