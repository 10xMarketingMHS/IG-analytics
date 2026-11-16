import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useEditors } from "@/lib/use-editors";
import { useIsSuper } from "@/lib/use-org";
import { useWorkspaces } from "@/lib/workspaces-context";
import { notifyTasksChanged } from "@/lib/task-events";

// Deleting a task, one rule wherever a task shows (the Task Board, the task's
// window on any page, My Team's task list). The server enforces the same
// (DELETE /tasks/:id in server/src/routes/tasks.js).
//   A finished task: the Super Admin; or an admin, when it was finished this
//   month and isn't their own (nor, the server checks, someone's above them).
//   Anything else: an admin or an assigner — or yours, if you made it for yourself.
// Deleting finished work takes it off goals and scores at once.
export type Deletable = { id: string; title: string; status: string; editor_id: string | null; completed_at: string | null; created_by?: string | null };

const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

export function useTaskDelete() {
  const { user } = useAuth();
  const { active, isAdmin, hasPermission } = useWorkspaces();
  const isSuper = useIsSuper();
  const { editors } = useEditors();
  const canWrite = active?.role !== "viewer";
  const canAssign = isAdmin || hasPermission("assign_tasks");
  const mine = (t: Deletable) => !!user?.editorId && t.editor_id === user.editorId;

  const canDelete = (t: Deletable): boolean => t.status === "done"
    ? isSuper || (isAdmin && !mine(t) && !!t.completed_at && monthOf(new Date(t.completed_at)) === monthOf(new Date()))
    : isAdmin || (canWrite && (canAssign || (mine(t) && !!user && t.created_by === user.id)));

  // Asks first; true once it's gone. after: what to do then (reload a list, close a window).
  async function del(t: Deletable, after?: () => void): Promise<boolean> {
    const who = t.status === "done" ? (editors ?? []).find((e) => e.id === t.editor_id)?.name : undefined;
    if (!window.confirm(t.status === "done"
      ? `Delete "${t.title}"? It's finished, so it comes off ${who ? `${who}'s` : "their"} goals and scores too. This can't be undone.`
      : `Delete "${t.title}"? This can't be undone.`)) return false;
    try {
      await api(`/tasks/${t.id}`, { method: "DELETE" });
      toast.success("Task deleted.");
      after?.();
      notifyTasksChanged();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete task.");
      return false;
    }
  }

  return { canDelete, del };
}
