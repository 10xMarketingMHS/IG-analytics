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

// The 80/20 split of Total Goal Points into an Overall Score:
//   Editor Earned Points = 80% × Σ[ min(1, actualJC/goalJC) × goalJC × points ]
//     — a points-weighted, per-type completion ratio (each type capped at 100%,
//       so overachieving one can't offset missing another), never lateness-
//       penalised (that lives in Task Points, kept separate on purpose).
//   Admin ceiling     = 20% × Total Goal Points.
//   Discipline points = (Σ 5 criterion ratings ÷ 25) × ceiling, computed live;
//                       each unrated criterion counts as 5 (full) until set.
//                       Inherently bounded by the ceiling (Σ ≤ 25), so Overall
//                       can never exceed Total even if goals change later.
//   Overall Score     = Earned + Discipline.
// Returns null when Total Goal Points is 0 (no goals) — nothing to split.
export type BreakdownRow = { goalJC: number; actualJC: number; points: number };
export type GoalBreakdown = {
  total: number; earned: number; ceiling: number;
  discipline: number; ratingSum: number; reviewed: boolean; overall: number;
};
export function goalBreakdown(rows: BreakdownRow[], ratings: Ratings): GoalBreakdown | null {
  const total = goalPointsTotal(rows.map((r) => ({ jc: r.goalJC, points: r.points })));
  if (total <= 0) return null;
  const earned = 0.8 * rows.reduce((s, r) => {
    const comp = r.goalJC > 0 ? Math.min(1, r.actualJC / r.goalJC) : 0;
    return s + comp * r.goalJC * r.points;
  }, 0);
  const ceiling = 0.2 * total;
  const ratingSum = DISCIPLINE_CRITERIA.reduce((s, c) => s + (ratings[c.key] ?? 5), 0);
  const reviewed = DISCIPLINE_CRITERIA.every((c) => ratings[c.key] != null);
  const discipline = (ratingSum / MAX_RATING_SUM) * ceiling;
  return { total, earned, ceiling, discipline, ratingSum, reviewed, overall: earned + discipline };
}
