import { useResource } from "@/lib/use-resource";

// A resolve_tasks grant can be narrowed to certain people, and for each of them
// to certain tasks (Settings → Access). null = may review everyone's tasks.
// taskIds null = every task assigned to that team member.
export type ReviewScope = { editors: { editorId: string; taskIds: string[] | null }[] } | null;

export function scopeAllowsTask(scope: ReviewScope, task: { id: string; editor_id: string | null }): boolean {
  if (!scope) return true;
  const entry = scope.editors.find((e) => e.editorId === task.editor_id);
  if (!entry) return false;
  return entry.taskIds == null || entry.taskIds.includes(task.id);
}

// The signed-in user's own review access. Admins don't need it (they can
// resolve anything); the server enforces the same rules either way.
export function useReviewAccess(): { granted: boolean; scope: ReviewScope } {
  const { data } = useResource<{ granted: boolean; scope: ReviewScope }>("/access/review-scope/me");
  return data ?? { granted: false, scope: null };
}
