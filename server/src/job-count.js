// Bulk work: one task for several of the same thing (10 stories, 5 posts),
// its count kept in meta.count (2–30; none = 1). It's timed and scored as that
// many jobs, reviewed once, and split into that many posts in Scheduling
// (routes/tasks.js makePostingCopies: pieces 2..N, meta.pieceOf).
export const MAX_JOBS = 30;

// SQL: a task row's count of jobs. `alias` is the task table's name in the query.
export const jobCount = (alias = "t") =>
  `greatest(1, least(${MAX_JOBS}, coalesce(case when ${alias}.meta->>'count' ~ '^[0-9]{1,2}$' then (${alias}.meta->>'count')::int end, 1)))`;

// JS: the same, from a task's meta
export const jobsOf = (meta) => {
  const n = Number(meta?.count);
  return Number.isInteger(n) && n > 1 ? Math.min(MAX_JOBS, n) : 1;
};

// Several in one task (How many) and posting on more brands than its own: Story
// and Post work only — a type named Story or Post (Stories, Posts), or a
// sub-type of one. Other work is one job on one brand. (pulse-app/src/lib/job-count.ts)
const SEVERAL = new Set(["story", "stories", "post", "posts"]);
export const severalNamed = (name, parentName) =>
  SEVERAL.has(String(name ?? "").trim().toLowerCase()) || SEVERAL.has(String(parentName ?? "").trim().toLowerCase());
export const SEVERAL_ONLY = "Only Story and Post work comes several in one task.";
export const BRANDS_ONLY = "Only Story and Post work can be posted on more than one brand.";
