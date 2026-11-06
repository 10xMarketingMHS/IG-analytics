import { useResource } from "@/lib/use-resource";

// Assign tasks can be limited to certain content types and to certain people
// (editor ids). A missing or null part isn't limited; null = no limit at all.
export type AssignScope = { formats?: string[] | null; editors?: string[] | null } | null;

// About you: whether any task can come to you for review (you assign work, or
// you're a Team Lead or above), and any limit on your Assign tasks. Who reviews
// each task is the server's call (server/src/review-route.js): every task in
// Review says can_review itself.
export function useReviewAccess(): { reviewer: boolean; assignScope: AssignScope } {
  const { data } = useResource<{ reviewer?: boolean; assignScope?: AssignScope }>("/access/review-scope/me");
  return { reviewer: data?.reviewer ?? false, assignScope: data?.assignScope ?? null };
}
