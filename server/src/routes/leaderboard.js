import { Router } from "express";
import { pool } from "../db.js";
import { requirePage } from "../page-access.js";
import { hasColumn } from "../schema-flags.js";
import { istAt, istNow, istYmd, readSettings } from "../attendance.js";
import { loadMonth, scoreLoaded, scoreMonthAll } from "../goal-score.js";
import { HOURS_CAP, SCORE_MAX, hoursScore, monthSoFar } from "../hours-score.js";
import { jobCount } from "../job-count.js";

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
// days past its due date it was finished (days waiting for a reviewer don't count)
function lateDays(t) {
  const workedUntil = new Date(new Date(t.completed_at).getTime() - Number(t.review_wait_seconds ?? 0) * 1000);
  return t.due_date ? daysBetween(String(t.due_date).slice(0, 10), istYmd(workedUntil)) : 0;
}
function taskPoints(t) {
  const basePts = t.base != null ? Number(t.base) : 1;
  const rework = reworkMultiplier(t.revision);
  const late = lateDays(t);
  if (late <= 0) return basePts * rework;
  if (late === 1) return basePts * 0.5 * rework;
  if (late === 2) return 0;
  return -basePts;
}

// Who's on the board, and the month's finished work (its points), read together.
async function boardData(orgId, first) {
  const scoreCol = (await hasColumn("editor", "in_task_score")) ? "e.in_task_score" : "true";
  const [{ rows: people }, { rows: done }] = await Promise.all([
    pool.query(
      `select e.id, e.name, coalesce(${scoreCol}, true) as scored from editor e where e.org_id = $1 and e.active`,
      [orgId],
    ),
    pool.query(
      `select t.editor_id, t.content_format_id, t.due_date, t.completed_at, t.revision, t.review_wait_seconds,
              coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points) as base,
              ${jobCount("t")} as jobs -- bulk work (../job-count.js) is that many jobs
         from task t left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and t.status = 'done' and t.task_type <> 'admin' and t.editor_id is not null
          and coalesce(t.meta->>'postsFor', '') = '' -- a posting copy is its original's work
          and t.completed_at >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
          and t.completed_at < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`,
      [orgId, first],
    ),
  ]);
  return { people: people.filter((p) => p.scored), done };
}

// The board's rows, in its order: everyone's points, jobs, hours, On time and
// score (../hours-score.js), from their finished work (done), their month's
// scoring (scores, ../goal-score.js) and how far into the month it is (soFar).
function boardRows(people, done, scores, soFar) {
  const rows = people.map((p) => {
    const mine = done.filter((t) => t.editor_id === p.id);
    const points = mine.reduce((s, t) => s + taskPoints(t) * (Number(t.jobs) || 1), 0);
    // the same work's points on time and without much rework: what On time is out of
    const fullPoints = mine.reduce((s, t) => s + Math.max(0, t.base != null ? Number(t.base) : 1) * (Number(t.jobs) || 1), 0);
    const s = scores.get(p.id);
    const completed = mine.reduce((n, t) => n + (Number(t.jobs) || 1), 0);
    const byType = (s?.types ?? []).map((t) => ({
      contentFormatId: t.contentFormatId, name: t.name, icon: t.icon,
      goal: Math.round(t.goal * 10) / 10, done: t.done, covered: s.coveredByType?.[t.contentFormatId] ?? 0, points: t.points,
      // jobs the time made up for (../goal-score.js rule 6)
      filled: Math.round((t.filled ?? 0) * 10) / 10,
    }));
    // what the goal % is made of, as shares of the goal's points: own goal work, the
    // time filling missed goals split between team goal credit and Other work
    // (it fills them evenly, so by their hours), and covered work on top
    const gp = s?.goalPoints ?? 0, fillH = (s?.creditHours ?? 0) + (s?.otherHours ?? 0);
    const share = fillH > 0 ? (s.creditHours ?? 0) / fillH : 0;
    const of = (pts) => Math.round((pts / gp) * 1000) / 10;
    const ownPts = (s?.types ?? []).reduce((n, t) => n + (t.own ?? 0) * t.points, 0);
    const filledPts = (s?.types ?? []).reduce((n, t) => n + (t.filled ?? 0) * t.points, 0);
    return {
      editorId: p.id, name: p.name, points: Math.round(points * 100) / 100, completed,
      // what took points off (the On time %): jobs finished late, and jobs sent back more than 3 times
      lateJobs: mine.filter((t) => lateDays(t) > 0).reduce((n, t) => n + (Number(t.jobs) || 1), 0),
      reworkJobs: mine.filter((t) => reworkMultiplier(t.revision) < 1).reduce((n, t) => n + (Number(t.jobs) || 1), 0),
      // the rank: Hours filled × On time, out of 1000 (../hours-score.js)
      ...hoursScore(s, { points, fullPoints, completed }, soFar),
      goalPoints: Math.round((s?.goalPoints ?? 0) * 10) / 10,
      goalPct: s?.pct == null ? null : Math.round(s.pct * 10) / 10,
      coveredJobs: s?.coveredJobs ?? 0, leaveDays: s?.leaveDays ?? 0, otherHours: s?.otherHours ?? 0,
      creditHours: s?.creditHours ?? 0, carriedJobs: (s?.carried ?? []).reduce((n, c) => n + c.jobs, 0),
      split: gp > 0 ? { own: of(ownPts), team: of(filledPts * share), co: of(filledPts * (1 - share)), covered: of(s.coveredPoints ?? 0) } : null,
      byType,
    };
  });
  // By the score, then points, then jobs done, then name; anyone with no score
  // (no working time yet, or nothing done) after, the same way.
  return rows.sort((a, b) =>
    (a.score == null) - (b.score == null)
    || (b.score ?? 0) - (a.score ?? 0)
    || b.points - a.points
    || b.completed - a.completed
    || String(a.name).localeCompare(String(b.name)));
}

const nextDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const monthOf = (q) => (/^\d{4}-\d{2}$/.test(String(q ?? "")) ? String(q) : istNow().ymd.slice(0, 7));

leaderboardRouter.get("/leaderboard/house", requirePage("leaderboard"), async (req, res, next) => {
  try {
    const month = monthOf(req.query.month);
    const first = `${month}-01`;
    const [{ people, done }, scores, { cal }] = await Promise.all([
      boardData(req.orgId, first), scoreMonthAll(req.orgId, first), readSettings(req.orgId),
    ]);
    // how far into the month its working time is (../hours-score.js)
    const now = istNow();
    const soFar = monthSoFar(cal, first, now.ymd, now.minutes);
    const rows = boardRows(people, done, scores, soFar).map(({ name, ...r }) => r);
    res.json({ month, rows, soFar: { workingDaysGone: Math.round(soFar.gone * 10) / 10, workingDays: soFar.total }, hoursCap: HOURS_CAP, scoreMax: SCORE_MAX });
  } catch (err) {
    next(err);
  }
});

// Progress Path (Leaderboard): the board as each day of the month closed, by the
// same score, so its last day is the board as it stands now. Everyone who had
// work that month (due or finished in it) is on it, ranked among themselves.
//   GET /leaderboard/path?month=YYYY-MM
//   → { month, days: [YYYY-MM-DD…, up to today], people: [{ editorId, scores: [], ranks: [] }] }
leaderboardRouter.get("/leaderboard/path", requirePage("leaderboard"), async (req, res, next) => {
  try {
    const month = monthOf(req.query.month);
    const first = `${month}-01`;
    const [{ people, done }, loaded, { cal }, { rows: worked }] = await Promise.all([
      boardData(req.orgId, first), loadMonth(req.orgId, first), readSettings(req.orgId),
      pool.query(
        `select distinct t.editor_id from task t
          where t.org_id = $1 and t.editor_id is not null and t.task_type <> 'admin'
            and coalesce(t.meta->>'postsFor', '') = ''
            and ((t.due_date >= $2::date and t.due_date < ($2::date + interval '1 month'))
              or (t.completed_at >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
                  and t.completed_at < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'))`,
        [req.orgId, first],
      ),
    ]);
    const hadWork = new Set(worked.map((r) => r.editor_id));
    const shown = people.filter((p) => hadWork.has(p.id));
    const now = istNow();
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days = [];
    for (let d = 1; d <= last; d++) {
      const day = `${month}-${String(d).padStart(2, "0")}`;
      if (day > now.ymd) break;
      days.push(day);
    }
    const line = new Map(shown.map((p) => [p.id, { editorId: p.id, scores: [], ranks: [] }]));
    for (const day of days) {
      const today = day === now.ymd;
      // as the day closed (today: as it stands now)
      const until = today ? new Date() : istAt(nextDay(day), "00:00");
      const soFar = monthSoFar(cal, first, day, today ? now.minutes : 24 * 60);
      const rows = boardRows(shown, done.filter((t) => new Date(t.completed_at) < until), scoreLoaded(loaded, { until }), soFar);
      rows.forEach((r, i) => {
        const l = line.get(r.editorId);
        l.scores.push(r.score ?? 0);
        l.ranks.push(i + 1);
      });
    }
    res.json({ month, days, people: [...line.values()], scoreMax: SCORE_MAX });
  } catch (err) {
    next(err);
  }
});
