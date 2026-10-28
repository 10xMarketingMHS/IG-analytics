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
// Who rates Discipline, and each one's share of its 20% (server/src/discipline.js):
// Manager 15 · Team Lead 5, or, with an Asst. Manager on the roster, 10 · 7 · 3.
export type RaterRole = "manager" | "asst_manager" | "lead";
export const RATER_ROLES: RaterRole[] = ["manager", "asst_manager", "lead"];
export const RATER_LABEL: Record<RaterRole, string> = { manager: "Manager", asst_manager: "Asst. Manager", lead: "Team Lead" };
export type Shares = Record<RaterRole, number>;
export const DEFAULT_SHARES: Shares = { manager: 15, asst_manager: 0, lead: 5 };
export type ByRole = Partial<Record<RaterRole, Ratings | null>>;

// What a month's work counts for is worked out on the server, by one rule for
// every screen (server/src/goal-score.js): goals cut for approved leave, each
// content type up to 150% of its goal (only assigned work goes beyond it), and
// covered work (taken over from someone) on top. Each row brings its goal after
// leave (goalJC) and the jobs that count (countedJC); covered work comes as
// points. This only splits that into the Overall Score:
//   Earned Points     = 80% × (Σ countedJC × points + covered points), at most
//                       150% of Total Goal Points
//                       — never lateness-penalised (that lives in Task Points).
//   Admin ceiling     = 20% × Total Goal Points.
//   Discipline points = for each rater (Manager, Asst. Manager, Team Lead):
//                       (Σ their 5 criterion ratings ÷ 25) × their share of the
//                       goal points; each unrated criterion counts as 5 (full).
//   Overall Score     = Earned + Discipline, which can pass the total (extra
//                       and covered work).
// Returns null when Total Goal Points is 0 (no goals) — nothing to split.
// Mirrors computeScore() in server/src/routes/management-performance.js.
export const TYPE_CAP = 1.5;
// the month as a whole, covered work included (server/src/goal-score.js TOTAL_CAP)
export const TOTAL_CAP = 1.5;
export type BreakdownRow = { goalJC: number; actualJC: number; points: number; countedJC?: number };
export type GoalBreakdown = {
  total: number; earned: number; ceiling: number;
  discipline: number; reviewed: boolean; overall: number;
  // each rater's stars out of 25 (unrated criteria as 5), and whether they rated any / all
  parts: Partial<Record<RaterRole, { share: number; stars: number; any: boolean; rated: boolean }>>;
};
// Each rater's part of the Discipline points, before the attendance penalty.
export function disciplineParts(total: number, byRole: ByRole, shares: Shares) {
  const parts: GoalBreakdown["parts"] = {};
  let points = 0;
  for (const role of RATER_ROLES) {
    const share = shares[role] ?? 0;
    if (!(share > 0)) continue;
    const r = byRole[role] ?? null;
    const stars = DISCIPLINE_CRITERIA.reduce((s, c) => s + (r?.[c.key] ?? 5), 0);
    parts[role] = { share, stars: Math.round(stars * 10) / 10, any: !!r && DISCIPLINE_CRITERIA.some((c) => r[c.key] != null), rated: !!r && DISCIPLINE_CRITERIA.every((c) => r[c.key] != null) };
    points += (stars / MAX_RATING_SUM) * (share / 100) * total;
  }
  return { parts, points };
}
// `penalty`: the month's attendance points lost (late, absent — Settings ›
// Attendance), taken off the discipline points, never below 0.
// `coveredPoints`: covered work, counted on top.
export function goalBreakdown(rows: BreakdownRow[], byRole: ByRole, shares: Shares, penalty = 0, coveredPoints = 0): GoalBreakdown | null {
  const total = goalPointsTotal(rows.map((r) => ({ jc: r.goalJC, points: r.points })));
  if (total <= 0) return null;
  // countedJC from the server; without it, the per-type limit alone
  const counted = (r: BreakdownRow) => (r.goalJC > 0 ? r.countedJC ?? Math.min(TYPE_CAP * r.goalJC, r.actualJC) : 0);
  const reached = Math.min(rows.reduce((s, r) => s + counted(r) * r.points, 0) + coveredPoints, TOTAL_CAP * total);
  const earned = 0.8 * reached;
  const ceiling = (RATER_ROLES.reduce((s, r) => s + (shares[r] ?? 0), 0) / 100) * total;
  const { parts, points } = disciplineParts(total, byRole, shares);
  const reviewed = Object.values(parts).every((p) => p?.rated);
  const discipline = Math.max(0, points - (penalty || 0));
  return { total, earned, ceiling, discipline, reviewed, overall: earned + discipline, parts };
}
