// Bulk work (server/src/job-count.js): one task for several of the same thing —
// 10 stories, 5 posts — kept in meta.count. Timed and scored as that many jobs,
// reviewed once, split into that many posts in Scheduling once approved.
import type { TaskMeta } from "@/lib/types";

export const MAX_JOBS = 30;
export const JOB_PICKS = [1, 5, 10, 15];
export function jobsOf(meta?: TaskMeta | null): number {
  const n = Number(meta?.count);
  return Number.isInteger(n) && n > 1 ? Math.min(MAX_JOBS, n) : 1;
}
// bulk work's own task in Scheduling is its first post: "1/10" (its other posts
// carry "· 2/10" in their titles)
export function pieceLabel(meta?: TaskMeta | null): string | null {
  const n = jobsOf(meta);
  return n > 1 && !meta?.postsFor ? `1/${n}` : null;
}
