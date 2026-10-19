import { useResource } from "@/lib/use-resource";

// A resolve_tasks grant can be narrowed (Settings › Access). null = may review
// everyone's tasks. { editors } = certain people, and for each of them certain
// tasks (taskIds null = every task assigned to that person). { formats } =
// every task of certain content types, e.g. all Carousels, whoever does them.
export type ReviewScope =
  | { editors: { editorId: string; taskIds: string[] | null }[] }
  | { formats: string[] }
  | null;
// Assign tasks can be limited to certain content types and to certain people
// (editor ids). A missing or null part isn't limited; null = no limit at all.
export type AssignScope = { formats?: string[] | null; editors?: string[] | null } | null;

export function scopeAllowsTask(scope: ReviewScope, task: { id: string; editor_id: string | null; content_format_id?: string | null }): boolean {
  if (!scope) return true;
  if ("formats" in scope) return !!task.content_format_id && scope.formats.includes(task.content_format_id);
  const entry = scope.editors.find((e) => e.editorId === task.editor_id);
  if (!entry) return false;
  return entry.taskIds == null || entry.taskIds.includes(task.id);
}

// The signed-in user's own review access. Admins don't need it (they can
// resolve anything); the server enforces the same rules either way.
export function useReviewAccess(): { granted: boolean; scope: ReviewScope; assignScope: AssignScope } {
  const { data } = useResource<{ granted: boolean; scope: ReviewScope; assignScope?: AssignScope }>("/access/review-scope/me");
  return { granted: data?.granted ?? false, scope: data?.scope ?? null, assignScope: data?.assignScope ?? null };
}
