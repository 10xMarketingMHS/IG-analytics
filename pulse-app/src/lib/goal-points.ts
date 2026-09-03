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
