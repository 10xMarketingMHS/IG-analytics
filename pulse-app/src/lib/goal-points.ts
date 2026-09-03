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

// The 80/20 split of Total Goal Points into an Overall Score:
//   Editor Earned Points = 80% × Σ[ min(1, actualJC/goalJC) × goalJC × points ]
//     — a points-weighted, per-type completion ratio (each type capped at 100%,
//       so overachieving one can't offset missing another), never lateness-
//       penalised (that lives in Task Points, kept separate on purpose).
//   Admin ceiling      = 20% × Total Goal Points.
//   Discipline points  = admin-entered, clamped to [0, ceiling]; null = "not
//                        reviewed" → treated as the full ceiling (full marks).
//   Overall Score      = Earned + Discipline.
// Returns null when Total Goal Points is 0 (no goals) — nothing to split.
export type BreakdownRow = { goalJC: number; actualJC: number; points: number };
export type GoalBreakdown = {
  total: number; earned: number; ceiling: number;
  discipline: number; disciplineIsDefault: boolean; overall: number;
};
export function goalBreakdown(rows: BreakdownRow[], disciplinePoints: number | null): GoalBreakdown | null {
  const total = goalPointsTotal(rows.map((r) => ({ jc: r.goalJC, points: r.points })));
  if (total <= 0) return null;
  const earned = 0.8 * rows.reduce((s, r) => {
    const comp = r.goalJC > 0 ? Math.min(1, r.actualJC / r.goalJC) : 0;
    return s + comp * r.goalJC * r.points;
  }, 0);
  const ceiling = 0.2 * total;
  const discipline = disciplinePoints == null ? ceiling : Math.max(0, Math.min(ceiling, disciplinePoints));
  return { total, earned, ceiling, discipline, disciplineIsDefault: disciplinePoints == null, overall: earned + discipline };
}
