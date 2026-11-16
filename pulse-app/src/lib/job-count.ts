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

// Several in one task (How many) and Also post on: Story and Post work only — a
// type named Story or Post (Stories, Posts), or a sub-type of one. Other work is
// one job on one brand. The server holds the same line (server/src/job-count.js).
const SEVERAL = new Set(["story", "stories", "post", "posts"]);
const severalName = (n?: string | null) => SEVERAL.has((n ?? "").trim().toLowerCase());
export function severalOk(f: { name: string; parent_id?: string | null } | null | undefined, all: { id: string; name: string }[] | null | undefined): boolean {
  if (!f) return false;
  return severalName(f.name) || (!!f.parent_id && severalName((all ?? []).find((x) => x.id === f.parent_id)?.name));
}
