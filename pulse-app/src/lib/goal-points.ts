// Goal points = Σ(JC × the content type's points) across an editor's goals for
// a month. "points" is task_content_format.points — the content type's
// "Individual scoring" value in Task Settings, NOT jph/hours. This total is
// purely informational: it never adds to anyone's actual Task Points
// (task-points.ts, scored from completed tasks) or changes their rank.
//
// One shared implementation, consumed by the Set Goals summary and (later) the
// Overall Progress leaderboard's per-editor "Goal" figure, so the two can never
// drift. Rows with no JC set (null) contribute 0.
export function goalPointsTotal(rows: Array<{ jc: number | null; points: number }>): number {
  return rows.reduce((sum, r) => sum + (r.jc ?? 0) * (r.points ?? 0), 0);
}

// The 5 Admin Discipline criteria, each rated 0–5, equally weighted. Keys match
// the editor_discipline_points columns. A fixed list (flat columns) for now.
export const DISCIPLINE_CRITERIA = [
  { key: "punctuality", label: "Punctuality" },
  { key: "quality_responsibility", label: "Quality & Responsibility" },
  { key: "behaviour", label: "Behaviour" },
  { key: "attendance_availability", label: "Attendance & Availability" },
  { key: "deadline_adherence", label: "Deadline Adherence" },
] as const;
export type CriterionKey = (typeof DISCIPLINE_CRITERIA)[number]["key"];
export type Ratings = Partial<Record<CriterionKey, number | null>>;
const MAX_RATING_SUM = DISCIPLINE_CRITERIA.length * 5; // 25

// What a month's work counts for is worked out on the server, by one rule for
// every screen (server/src/goal-score.js): goals cut for approved leave, each
// content type up to 150% of its goal (only assigned work goes beyond it), and
// covered work (taken over from someone) on top. Each row brings its goal after
// leave (goalJC) and the jobs that count (countedJC); covered work comes as
// points. This only splits that into the Overall Score:
//   Earned Points     = 80% × (Σ countedJC × points + covered points)
//                       — never lateness-penalised (that lives in Task Points).
//   Admin ceiling     = 20% × Total Goal Points.
//   Discipline points = (Σ 5 criterion ratings ÷ 25) × ceiling, computed live;
//                       each unrated criterion counts as 5 (full) until set.
//   Overall Score     = Earned + Discipline, which can pass the total (extra
//                       and covered work).
// Returns null when Total Goal Points is 0 (no goals) — nothing to split.
// Mirrors computeScore() in server/src/routes/management-performance.js.
export const TYPE_CAP = 1.5;
export type BreakdownRow = { goalJC: number; actualJC: number; points: number; countedJC?: number };
export type GoalBreakdown = {
  total: number; earned: number; ceiling: number;
  discipline: number; ratingSum: number; reviewed: boolean; overall: number;
};
// `penalty`: the month's attendance points lost (late, absent — Settings ›
// Attendance), taken off the discipline points, never below 0.
// `coveredPoints`: covered work, counted on top.
export function goalBreakdown(rows: BreakdownRow[], ratings: Ratings, penalty = 0, coveredPoints = 0): GoalBreakdown | null {
  const total = goalPointsTotal(rows.map((r) => ({ jc: r.goalJC, points: r.points })));
  if (total <= 0) return null;
  // countedJC from the server; without it, the per-type limit alone
  const counted = (r: BreakdownRow) => (r.goalJC > 0 ? r.countedJC ?? Math.min(TYPE_CAP * r.goalJC, r.actualJC) : 0);
  const earned = 0.8 * (rows.reduce((s, r) => s + counted(r) * r.points, 0) + coveredPoints);
  const ceiling = 0.2 * total;
  const ratingSum = DISCIPLINE_CRITERIA.reduce((s, c) => s + (ratings[c.key] ?? 5), 0);
  const reviewed = DISCIPLINE_CRITERIA.every((c) => ratings[c.key] != null);
  const discipline = Math.max(0, (ratingSum / MAX_RATING_SUM) * ceiling - (penalty || 0));
  return { total, earned, ceiling, discipline, ratingSum, reviewed, overall: earned + discipline };
}
