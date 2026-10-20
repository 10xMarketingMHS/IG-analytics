import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { openingFor, readSettings } from "./attendance.js";

// Goal scoring: one rule for the Leaderboard, Goals and Management
// Performance. (pulse-app/src/lib/goal-points.ts takes the counted numbers
// worked out here, so the app never scores goals its own way.)
//
//  1. Each content type counts up to 150% of its goal, so work beyond the goal
//     earns more, within a limit.
//  2. Covered work counts on top, at the points it locked in, even on a type
//     with no goal, and outside the 150%. Covered = a task that reached you
//     from someone who had already taken it on: an accepted hand-over, a Move
//     once a hand-over climbed, or a lead reassigning an accepted task
//     (task.covered_from_editor_id).
//  3. Work nobody gave you (a task you made for yourself, or picked up while it
//     was unassigned) counts toward the goal, never beyond it. Assigned work
//     makes up any part beyond.
//  4. Approved leave (a lead's Leave or Half day in Attendance) shrinks the
//     goal for scoring by days off ÷ working days; the goal as set stays. An
//     unexcused absence doesn't shrink it (its penalty comes off discipline).
//  5. So a score can pass 100%.
// A goal job is worth the points the goal was set with.
export const TYPE_CAP = 1.5;

const NIL = "00000000-0000-0000-0000-000000000000";
const IST_MONTH = (col) => `${col} >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
  and ${col} < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`;

// One person's month. goals: [{ contentFormatId, name, icon, goalJC, points }];
// jobs: [{ contentFormatId, source: "self" | "assigned" | "covered", points }].
export function scoreMonth({ goals, jobs, leaveDays = 0, workingDays = 0 }) {
  const leaveFactor = workingDays > 0 ? Math.max(0, 1 - leaveDays / workingDays) : 1;
  const types = new Map();
  for (const g of goals) {
    if (!(g.goalJC > 0)) continue;
    types.set(g.contentFormatId, {
      contentFormatId: g.contentFormatId, name: g.name ?? null, icon: g.icon ?? null,
      goalJC: g.goalJC, goal: g.goalJC * leaveFactor, points: g.points,
      done: 0, self: 0, assigned: 0, covered: 0, counted: 0,
    });
  }
  let coveredPoints = 0, coveredJobs = 0, otherCovered = 0;
  const coveredByType = {};
  for (const j of jobs) {
    const t = j.contentFormatId ? types.get(j.contentFormatId) : null;
    if (j.source === "covered") {
      // at the goal's points for that type when there's a goal, like goal work
      coveredPoints += t ? t.points : j.points;
      coveredJobs++;
      if (j.contentFormatId) coveredByType[j.contentFormatId] = (coveredByType[j.contentFormatId] ?? 0) + 1;
      if (!t) otherCovered++;
    }
    if (!t) continue;
    t.done++;
    t[j.source]++;
  }
  let goalPoints = 0, jobsPoints = 0, goalTarget = 0, achieved = otherCovered;
  for (const t of types.values()) {
    const regular = t.self + t.assigned;
    // your own work fills the goal first; only assigned work goes beyond it
    const extra = Math.min(t.assigned, Math.max(0, regular - t.goal));
    t.counted = Math.min(t.goal, regular) + Math.min(extra, (TYPE_CAP - 1) * t.goal);
    goalPoints += t.goal * t.points;
    jobsPoints += t.counted * t.points;
    goalTarget += t.goal;
    achieved += t.done;
  }
  const reached = jobsPoints + coveredPoints;
  return {
    leaveDays, workingDays, leaveFactor,
    types: [...types.values()], coveredByType,
    goalPoints, jobsPoints, coveredPoints, coveredJobs, reached,
    goalTarget, achieved,
    pct: goalPoints > 0 ? (reached / goalPoints) * 100 : null,
  };
}

// Everyone's month (or one person's): goals, jobs completed (by India time),
// approved leave and working days, scored.
export async function scoreMonthAll(orgId, monthFirst, editorId = null) {
  const one = editorId ? " and editor_id = $3" : "";
  const P = editorId ? [orgId, monthFirst, editorId] : [orgId, monthFirst];
  const covered = (await hasColumn("task", "covered_from_editor_id")) ? "t.covered_from_editor_id" : "null::uuid";
  const { effectiveCapacity } = await import("./routes/goals.js");
  const [goalRes, jobRes, leaveRes, capRes, orgCap] = await Promise.all([
    pool.query(
      `select g.editor_id, g.content_format_id, g.jc::float as jc, cf.name, cf.icon,
              coalesce((to_jsonb(g)->>'points')::numeric, cf.points)::float as pts
         from editor_goal g join task_content_format cf on cf.id = g.content_format_id
        where g.org_id = $1 and g.period_month = $2::date${one.replace("editor_id", "g.editor_id")}`,
      P,
    ),
    pool.query(
      `select t.editor_id, t.content_format_id, t.assigned_by, ${covered} as covered_from,
              coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points, 1)::float as pts
         from task t left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and t.status = 'done' and t.task_type <> 'admin' and t.editor_id is not null
          and ${IST_MONTH("t.completed_at")}${one.replace("editor_id", "t.editor_id")}`,
      P,
    ),
    (await hasColumn("attendance", "id"))
      ? pool.query(
        `select editor_id, date::text as day, status
           from attendance
          where org_id = $1 and date >= $2::date and date < ($2::date + interval '1 month')
            and status in ('leave', 'half_day')${one}`,
        P,
      )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `select editor_id, working_days from editor_capacity
        where org_id = $1 and period_month = $2::date and editor_id is not null${one}`,
      P,
    ),
    // working days when a person has no capacity of their own: the org's
    effectiveCapacity(orgId, NIL, monthFirst),
  ]);
  const fallbackDays = Number(orgCap.working_days) || 0;

  const goals = new Map(), jobs = new Map();
  for (const g of goalRes.rows) {
    if (!goals.has(g.editor_id)) goals.set(g.editor_id, []);
    goals.get(g.editor_id).push({ contentFormatId: g.content_format_id, name: g.name, icon: g.icon, goalJC: Number(g.jc), points: Number(g.pts ?? 0) });
  }
  for (const t of jobRes.rows) {
    if (!jobs.has(t.editor_id)) jobs.set(t.editor_id, []);
    const source = t.covered_from && t.covered_from !== t.editor_id ? "covered" : t.assigned_by ? "assigned" : "self";
    jobs.get(t.editor_id).push({ contentFormatId: t.content_format_id, source, points: Number(t.pts ?? 1) });
  }
  // Leave shrinks the goal only on working days (not a Sunday, a Saturday off or a holiday).
  const { cal } = await readSettings(orgId);
  const leave = new Map();
  for (const r of leaveRes.rows) {
    if (!openingFor(cal, r.day)) continue;
    leave.set(r.editor_id, (leave.get(r.editor_id) ?? 0) + (r.status === "leave" ? 1 : 0.5));
  }
  const days = new Map(capRes.rows.map((r) => [r.editor_id, Number(r.working_days)]));

  const ids = new Set([...goals.keys(), ...jobs.keys()]);
  if (editorId) ids.add(editorId);
  const out = new Map();
  for (const id of ids) {
    out.set(id, scoreMonth({
      goals: goals.get(id) ?? [], jobs: jobs.get(id) ?? [],
      leaveDays: leave.get(id) ?? 0, workingDays: days.get(id) ?? fallbackDays,
    }));
  }
  return out;
}

// Who a task is taken over from when it moves to `toEditorId` — the person
// who had it (or, if it had already been covered, the person it first
// belonged to); null when it goes back to them, or to nobody.
export function coverFrom(currentCoveredFrom, fromEditorId, toEditorId) {
  const origin = currentCoveredFrom ?? fromEditorId ?? null;
  if (!toEditorId || !origin || origin === toEditorId) return null;
  return origin;
}
