import { Router } from "express";
import { pool } from "../db.js";
import { requirePage } from "../page-access.js";
import { hasColumn } from "../schema-flags.js";
import { istNow, istYmd } from "../attendance.js";
import { scoreMonthAll } from "../goal-score.js";

// Media House Leaders (Leaderboard), worked out here so everyone sees the
// same board whoever is looking (a member's own task list leaves out the
// tasks of people above them).
//
// The month's points are the Points Formula, as pulse-app/src/lib/task-points.ts
// (keep the two in step): each completed task earns the points it locked in
// when approved (or its type's points, or 1 with no type) × lateness (on time
// 100%, 1 day late 50%, 2 days 0, 3+ days the points taken back) × rework
// (after 3 send-backs 70%, 5: 50%, 7: 20%). Days waiting for a reviewer don't
// count as late. Admin tasks never score.
//
// The rank is the share of the person's own goal reached, by the one goal rule
// (../goal-score.js): jobs per content type, each type up to its goal (cut for
// approved leave), time from team goal credit and Other work filling missed
// goals, plus covered work on top, weighed by the goal's
// points, so changing a type's points, or late work, never moves it. Points
// break ties. No goal set: listed after.
export const leaderboardRouter = Router();

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
function reworkMultiplier(revision) {
  const r = Number(revision ?? 0);
  if (r <= 3) return 1;
  if (r <= 5) return 0.7;
  if (r <= 7) return 0.5;
  return 0.2;
}
function taskPoints(t) {
  const basePts = t.base != null ? Number(t.base) : 1;
  const rework = reworkMultiplier(t.revision);
  const workedUntil = new Date(new Date(t.completed_at).getTime() - Number(t.review_wait_seconds ?? 0) * 1000);
  const late = t.due_date ? daysBetween(String(t.due_date).slice(0, 10), istYmd(workedUntil)) : 0;
  if (late <= 0) return basePts * rework;
  if (late === 1) return basePts * 0.5 * rework;
  if (late === 2) return 0;
  return -basePts;
}

leaderboardRouter.get("/leaderboard/house", requirePage("leaderboard"), async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? "")) ? String(req.query.month) : istNow().ymd.slice(0, 7);
    const first = `${month}-01`;
    const scoreCol = (await hasColumn("editor", "in_task_score")) ? "e.in_task_score" : "true";
    // who's on the board, the month's completed tasks and the goal scores, read together
    const [{ rows: people }, { rows: done }, scores] = await Promise.all([
      pool.query(
        `select e.id, e.name, coalesce(${scoreCol}, true) as scored from editor e where e.org_id = $1 and e.active`,
        [req.orgId],
      ),
      pool.query(
        `select t.editor_id, t.content_format_id, t.due_date, t.completed_at, t.revision, t.review_wait_seconds,
                coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points) as base
           from task t left join task_content_format cf on cf.id = t.content_format_id
          where t.org_id = $1 and t.status = 'done' and t.task_type <> 'admin' and t.editor_id is not null
            and coalesce(t.meta->>'postsFor', '') = '' -- a posting copy is its original's work
            and t.completed_at >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
            and t.completed_at < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`,
        [req.orgId, first],
      ),
      scoreMonthAll(req.orgId, first),
    ]);
    const rows = people.filter((p) => p.scored).map((p) => {
      const mine = done.filter((t) => t.editor_id === p.id);
      const points = mine.reduce((s, t) => s + taskPoints(t), 0);
      const s = scores.get(p.id);
      const byType = (s?.types ?? []).map((t) => ({
        contentFormatId: t.contentFormatId, name: t.name, icon: t.icon,
        goal: Math.round(t.goal * 10) / 10, done: t.done, covered: s.coveredByType?.[t.contentFormatId] ?? 0, points: t.points,
        // jobs the time made up for (../goal-score.js rule 6)
        filled: Math.round((t.filled ?? 0) * 10) / 10,
      }));
      // what the % is made of, as shares of the goal's points: own goal work, the
      // time filling missed goals split between team goal credit and Other work
      // (it fills them evenly, so by their hours), and covered work on top
      const gp = s?.goalPoints ?? 0, fillH = (s?.creditHours ?? 0) + (s?.otherHours ?? 0);
      const share = fillH > 0 ? (s.creditHours ?? 0) / fillH : 0;
      const of = (pts) => Math.round((pts / gp) * 1000) / 10;
      const ownPts = (s?.types ?? []).reduce((n, t) => n + (t.own ?? 0) * t.points, 0);
      const filledPts = (s?.types ?? []).reduce((n, t) => n + (t.filled ?? 0) * t.points, 0);
      return {
        editorId: p.id, points: Math.round(points * 100) / 100, completed: mine.length,
        goalPoints: Math.round((s?.goalPoints ?? 0) * 10) / 10,
        goalPct: s?.pct == null ? null : Math.round(s.pct * 10) / 10,
        coveredJobs: s?.coveredJobs ?? 0, leaveDays: s?.leaveDays ?? 0, otherHours: s?.otherHours ?? 0,
        creditHours: s?.creditHours ?? 0, carriedJobs: (s?.carried ?? []).reduce((n, c) => n + c.jobs, 0),
        split: gp > 0 ? { own: of(ownPts), team: of(filledPts * share), co: of(filledPts * (1 - share)), covered: of(s.coveredPoints ?? 0) } : null,
        byType,
      };
    });
    // With a goal: by % reached, then points, then jobs done. Then everyone
    // without a goal, by points.
    rows.sort((a, b) =>
      (a.goalPct == null) - (b.goalPct == null)
      || (b.goalPct ?? 0) - (a.goalPct ?? 0)
      || b.points - a.points
      || b.completed - a.completed);
    res.json({ month, rows });
  } catch (err) {
    next(err);
  }
});
