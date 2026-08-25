import { useEffect } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";

const SEEN_KEY_PREFIX = "pulse-seen-tasks-";

function readSeen(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY_PREFIX + userId);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function writeSeen(userId: string, seen: Set<string>) {
  window.localStorage.setItem(SEEN_KEY_PREFIX + userId, JSON.stringify([...seen]));
}

// Call right after taking an action that assigns a task to yourself in this
// tab (self-assign, accept, claim) — so the background poller below doesn't
// also pop a redundant "new task" toast about something you just did.
export function noteTaskSeen(userId: string, taskId: string) {
  const seen = readSeen(userId);
  seen.add(taskId);
  writeSeen(userId, seen);
}

// Polls the caller's own assigned tasks and toasts (bottom-right, via the
// app's shared <Toaster/>) for any that showed up since the last poll — a
// new assignment, whether admin-assigned, auto-created from a post, or
// claimed by someone else's action. Mounted once in the app shell so it
// fires from any page, not just the Task Board. The very first poll on a
// given browser just establishes a baseline — no toast storm for work that
// already existed before this session started.
export function useTaskAssignNotify() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.editorId) return;
    let cancelled = false;

    async function poll() {
      try {
        const { tasks } = await api<{ tasks: Task[] }>("/tasks?assignee=me");
        if (cancelled) return;
        const key = SEEN_KEY_PREFIX + user!.id;
        const isFirstEver = window.localStorage.getItem(key) === null;
        const seen = readSeen(user!.id);
        if (!isFirstEver) {
          for (const t of tasks) {
            if (seen.has(t.id)) continue;
            toast(`🔔 New task: "${t.title}"`, {
              description: t.due_date ? `Due ${t.due_date}` : undefined,
            });
          }
        }
        tasks.forEach((t) => seen.add(t.id));
        writeSeen(user!.id, seen);
      } catch {
        // Background nicety — stay silent on failure, next poll retries.
      }
    }

    poll();
    const id = setInterval(poll, 45_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user?.editorId, user?.id]);
}
