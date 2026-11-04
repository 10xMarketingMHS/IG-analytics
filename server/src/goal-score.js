import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { openingFor, readSettings } from "./attendance.js";

// Goal scoring: one rule for the Leaderboard, Goals and Management
// Performance. (pulse-app/src/lib/goal-points.ts takes the counted numbers
// worked out here, so the app never scores goals its own way.)
//
//  1. Each content type counts up to its goal: your own work on it, given to
//     you or not. Work beyond your goal is rule 3's.
//  2. Covered work counts on top, at the points it locked in, even on a type
//     with no goal, and outside rule 6. Covered = a task that reached you
//     from someone who had already taken it on: an accepted hand-over, a Move
//     once a hand-over climbed, or a lead reassigning an accepted task
//     (task.covered_from_editor_id).
//  3. Team goal credit: a job beyond your own goal of a type, or of a type in
//     the team's goals that isn't on your card, counts while the team still
//     needs that type this month (everyone's goals for it added up, less the
//     work done toward them) — first done, first counted. It's worth its time
//     (Settings › Tasks & time). What the team didn't need is carried to next
//     month: shown, not counted.
//  4. Approved leave (a lead's Leave or Half day in Attendance) shrinks the
//     goal for scoring by days off ÷ working days; the goal as set stays. An
//     unexcused absence doesn't shrink it (its penalty comes off discipline).
//  5. Other work: a task of a type that isn't in the team's goals this month
//     (another team's videos, packaging, a camp…), given to you or added by
//     you — it counts once it's done, which for your own means your lead
//     approved it in Review — is worth the time it took: what its timer ran,
//     never more than the time it was given ("Should take", or the type's
//     time); a task with none is worth nothing.
//  6. The time from rules 3 and 5 fills the goals you missed, by the hours
//     they were short (the jobs missing × each job's time), never past the
//     goal. A type with no time per job can't be filled by time.
//  7. So a score passes 100% only with covered work, up to 150% for the month.
// A goal job is worth the points the goal was set with.
export const TYPE_CAP = 1;
// The whole month together (covered work included) is capped too: at most 150%
// of the goal's points.
export const TOTAL_CAP = 1.5;

const NIL = "00000000-0000-0000-0000-000000000000";
const IST_MONTH = (col) => `${col} >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
  and ${col} < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`;
const tenth = (n) => Math.round(n * 10) / 10;
const byTime = (a, b) => (new Date(a.completedAt ?? 0) - new Date(b.completedAt ?? 0)) || String(a.taskId ?? "").localeCompare(String(b.taskId ?? ""));

// Rule 3 for the whole team: each type's need (everyone's goal for it added
// up), what's done toward it (each person's work up to their own goal, and
// covered work), then the jobs beyond that, first done first counted, until
// the need is met; the rest is carried.
// goalsBy / jobsBy: Map editorId → that person's goals / jobs (as scoreMonth).
// Returns credit: Map editorId → { [contentFormatId]: { name, credited, carried } },
// and team: { [contentFormatId]: { target, done, left } }.
export function teamCredit(goalsBy, jobsBy) {
  const target = new Map();
  for (const goals of goalsBy.values()) {
    for (const g of goals) if (g.goalJC > 0) target.set(g.contentFormatId, (target.get(g.contentFormatId) ?? 0) + g.goalJC);
  }
  const done = new Map([...target.keys()].map((f) => [f, 0]));
  const extra = [];
  for (const [id, jobs] of jobsBy) {
    const own = new Map((goalsBy.get(id) ?? []).filter((g) => g.goalJC > 0).map((g) => [g.contentFormatId, g.goalJC]));
    const used = new Map();
    for (const j of [...jobs].sort(byTime)) {
      const f = j.contentFormatId;
      if (!f || !target.has(f)) continue;
      if (j.source === "covered") { done.set(f, done.get(f) + 1); continue; }
      const n = (used.get(f) ?? 0) + 1;
      used.set(f, n);
      if (n <= (own.get(f) ?? 0)) done.set(f, done.get(f) + 1);
      else extra.push({ id, f, name: j.typeName ?? null, completedAt: j.completedAt, taskId: j.taskId });
    }
  }
  const credit = new Map();
  for (const x of extra.sort(byTime)) {
    if (!credit.has(x.id)) credit.set(x.id, {});
    const c = (credit.get(x.id)[x.f] ??= { name: x.name, credited: 0, carried: 0 });
    if (done.get(x.f) < target.get(x.f)) { done.set(x.f, done.get(x.f) + 1); c.credited++; } else c.carried++;
  }
  const team = Object.fromEntries([...target].map(([f, t]) => [f, { target: t, done: done.get(f), left: Math.max(0, t - done.get(f)) }]));
  return { credit, team };
}

// One person's month. goals: [{ contentFormatId, name, icon, goalJC, points }];
// jobs: [{ contentFormatId, source: "self" | "assigned" | "covered", points, hours }].
// teamTypes: the types in the team's goals (rule 5; default: this person's);
// credit: their rule 3 jobs ({ [contentFormatId]: { name, credited, carried } });
// jobHours: { [contentFormatId]: hours one job takes them } (rules 3 and 6).
export function scoreMonth({ goals, jobs, leaveDays = 0, workingDays = 0, hoursPerDay = 8, teamTypes = null, credit = {}, jobHours = {} }) {
  const leaveFactor = workingDays > 0 ? Math.max(0, 1 - leaveDays / workingDays) : 1;
  const goalTypes = new Set(goals.filter((g) => g.goalJC > 0).map((g) => g.contentFormatId));
  const inTeam = teamTypes ?? goalTypes;
  const timeOf = (f) => Math.max(0, Number(jobHours[f]) || 0);
  // rule 5: Other work, at the time it took
  // (a timer that ran only a few minutes — under 6 — isn't worth listing or counting)
  const otherWork = jobs.filter((j) => j.source !== "covered" && !(j.contentFormatId && inTeam.has(j.contentFormatId)) && j.hours >= 0.1);
  const otherHours = otherWork.reduce((n, j) => n + j.hours, 0);
  // rule 3: team goal credit, at each job's time
  const credited = Object.entries(credit).filter(([, c]) => c.credited > 0)
    .map(([f, c]) => ({ contentFormatId: f, name: c.name ?? null, jobs: c.credited, hours: tenth(c.credited * timeOf(f)) }));
  const carried = Object.entries(credit).filter(([, c]) => c.carried > 0)
    .map(([f, c]) => ({ contentFormatId: f, name: c.name ?? null, jobs: c.carried }));
  const creditHours = Object.entries(credit).reduce((n, [f, c]) => n + c.credited * timeOf(f), 0);
  const types = new Map();
  for (const g of goals) {
    if (!(g.goalJC > 0)) continue;
    types.set(g.contentFormatId, {
      contentFormatId: g.contentFormatId, name: g.name ?? null, icon: g.icon ?? null,
      goalJC: g.goalJC, goal: g.goalJC * leaveFactor, points: g.points, jobHours: timeOf(g.contentFormatId),
      done: 0, self: 0, assigned: 0, covered: 0, own: 0, filled: 0, counted: 0,
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
  // rule 6: the time fills what's missing, evenly by the hours each type is short
  let shortHours = 0;
  for (const t of types.values()) {
    t.own = Math.min(t.goal, t.self + t.assigned);
    shortHours += (t.goal - t.own) * t.jobHours;
  }
  const fillHours = creditHours + otherHours;
  const filledHours = Math.min(fillHours, shortHours);
  const share = shortHours > 0 ? filledHours / shortHours : 0;
  let goalPoints = 0, jobsPoints = 0, goalTarget = 0, achieved = otherCovered, leftPoints = 0;
  for (const t of types.values()) {
    t.filled = t.jobHours > 0 ? (t.goal - t.own) * share : 0;
    t.counted = t.own + t.filled;
    goalPoints += t.goal * t.points;
    jobsPoints += t.counted * t.points;
    if (t.jobHours > 0) leftPoints += (t.goal - t.counted) * t.points;
    goalTarget += t.goal;
    achieved += t.done;
  }
  const uncapped = jobsPoints + coveredPoints;
  const reached = goalPoints > 0 ? Math.min(uncapped, TOTAL_CAP * goalPoints) : uncapped;
  const stillShort = Math.max(0, shortHours - filledHours);
  return {
    leaveDays, workingDays, leaveFactor, hoursPerDay,
    // the goal as it counts: cut for approved leave only (rule 4)
    timeFactor: leaveFactor,
    otherHours: tenth(otherHours),
    otherWork: otherWork.map((j) => ({
      taskId: j.taskId ?? null, title: j.title ?? null, typeName: j.typeName ?? null,
      requestedBy: j.requestedBy ?? null, hours: tenth(j.hours), completedAt: j.completedAt ?? null,
      // added by the person themselves (and approved), not given
      selfMade: j.source === "self",
    })),
    creditHours: tenth(creditHours), credit: credited, carried,
    // the hours check: short on the goals, filled by time, still short
    shortHours: tenth(shortHours), filledHours: tenth(filledHours), stillShortHours: tenth(stillShort),
    // what an hour of time is worth while anything is still short (New task's How it scores)
    pointsPerShortHour: stillShort > 0 ? leftPoints / stillShort : 0,
    types: [...types.values()], coveredByType,
    goalPoints, jobsPoints, coveredPoints, coveredJobs, reached, uncapped,
    goalTarget, achieved,
    pct: goalPoints > 0 ? (reached / goalPoints) * 100 : null,
  };
}

// Everyone's month (or one person's): goals, jobs completed (by India time),
// approved leave and working days, scored. Rule 3 needs the whole team, so
// goals and jobs are always read for everyone.
export async function scoreMonthAll(orgId, monthFirst, editorId = null) {
  const one = editorId ? " and editor_id = $3" : "";
  const P = editorId ? [orgId, monthFirst, editorId] : [orgId, monthFirst];
  const covered = (await hasColumn("task", "covered_from_editor_id")) ? "t.covered_from_editor_id" : "null::uuid";
  const { effectiveCapacity } = await import("./routes/goals.js");
  const [goalRes, jobRes, leaveRes, capRes, orgCap, ruleRes] = await Promise.all([
    pool.query(
      `select g.editor_id, g.content_format_id, g.jc::float as jc, g.jph::float as jph, cf.name, cf.icon, cf.category, cf.duration_days::float as duration_days,
              coalesce((to_jsonb(g)->>'points')::numeric, cf.points)::float as pts
         from editor_goal g join task_content_format cf on cf.id = g.content_format_id
        where g.org_id = $1 and g.period_month = $2::date
          and coalesce((to_jsonb(cf)->>'counts_in_goal')::boolean, true)`,
      [orgId, monthFirst],
    ),
    pool.query(
      `select t.editor_id, t.content_format_id, t.assigned_by, ${covered} as covered_from,
              coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points, 1)::float as pts,
              t.id, t.title, cf.name as type_name, cf.category, cf.duration_days::float as duration_days,
              t.meta->>'requestedBy' as requested_by, t.completed_at,
              -- the time it took (rule 5): its timer, never more than the time it was given
              least(
                (coalesce(t.budget_used_seconds, 0)
                  + case when t.budget_started_at is not null and t.completed_at > t.budget_started_at
                         then extract(epoch from (t.completed_at - t.budget_started_at)) else 0 end) / 3600.0,
                t.budget_hours)::float as hours
         from task t left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and t.status = 'done' and t.task_type <> 'admin' and t.editor_id is not null
          and ${IST_MONTH("t.completed_at")}`,
      [orgId, monthFirst],
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
      `select editor_id, working_days, hours_per_day from editor_capacity
        where org_id = $1 and period_month = $2::date and editor_id is not null${one}`,
      P,
    ),
    // working days when a person has no capacity of their own: the org's
    effectiveCapacity(orgId, NIL, monthFirst),
    // each type's time per job (Settings › Tasks & time): a person's own, else the org's
    pool.query("select content_format_id, editor_id, hours::float as hours from task_time_rule where org_id = $1", [orgId]),
  ]);
  const fallbackDays = Number(orgCap.working_days) || 0;
  const fallbackHours = Number(orgCap.hours_per_day) || 8;

  const goals = new Map(), jobs = new Map(), kinds = new Map();
  for (const g of goalRes.rows) {
    if (!goals.has(g.editor_id)) goals.set(g.editor_id, []);
    goals.get(g.editor_id).push({ contentFormatId: g.content_format_id, name: g.name, icon: g.icon, goalJC: Number(g.jc), points: Number(g.pts ?? 0), jph: Number(g.jph) || 0 });
    kinds.set(g.content_format_id, g);
  }
  for (const t of jobRes.rows) {
    if (!jobs.has(t.editor_id)) jobs.set(t.editor_id, []);
    const source = t.covered_from && t.covered_from !== t.editor_id ? "covered" : t.assigned_by ? "assigned" : "self";
    jobs.get(t.editor_id).push({
      contentFormatId: t.content_format_id, source, points: Number(t.pts ?? 1),
      hours: Number(t.hours) || 0, taskId: t.id, title: t.title, typeName: t.type_name, requestedBy: t.requested_by, completedAt: t.completed_at,
    });
    if (t.content_format_id && !kinds.has(t.content_format_id)) kinds.set(t.content_format_id, t);
  }
  const { credit, team } = teamCredit(goals, jobs);
  const teamTypes = new Set(Object.keys(team));
  // a job's time for a person: a project's days of work; else the goal's own
  // hours per job (Set goals); else the type's time, theirs or the org's
  const rule = new Map(ruleRes.rows.map((r) => [`${r.content_format_id}:${r.editor_id ?? ""}`, Number(r.hours)]));
  const timeFor = (id, f, hpd, goalJph) => {
    const k = kinds.get(f);
    if (k?.category === "project" && k.duration_days != null) return Number(k.duration_days) * hpd;
    return goalJph > 0 ? goalJph : rule.get(`${f}:${id}`) ?? rule.get(`${f}:`) ?? 0;
  };

  // Leave shrinks the goal only on working days (not a Sunday, a Saturday off or a holiday).
  const { cal } = await readSettings(orgId);
  const leave = new Map();
  for (const r of leaveRes.rows) {
    if (!openingFor(cal, r.day)) continue;
    leave.set(r.editor_id, (leave.get(r.editor_id) ?? 0) + (r.status === "leave" ? 1 : 0.5));
  }
  const days = new Map(capRes.rows.map((r) => [r.editor_id, Number(r.working_days)]));
  const dayHours = new Map(capRes.rows.map((r) => [r.editor_id, Number(r.hours_per_day)]));

  const ids = editorId ? new Set([editorId]) : new Set([...goals.keys(), ...jobs.keys()]);
  const out = new Map();
  for (const id of ids) {
    const hpd = dayHours.get(id) || fallbackHours;
    const mine = credit.get(id) ?? {};
    const jobHours = {};
    for (const g of goals.get(id) ?? []) jobHours[g.contentFormatId] = timeFor(id, g.contentFormatId, hpd, g.jph);
    for (const f of Object.keys(mine)) jobHours[f] ??= timeFor(id, f, hpd, 0);
    out.set(id, {
      ...scoreMonth({
        goals: goals.get(id) ?? [], jobs: jobs.get(id) ?? [],
        leaveDays: leave.get(id) ?? 0, workingDays: days.get(id) ?? fallbackDays,
        hoursPerDay: hpd, teamTypes, credit: mine, jobHours,
      }),
      team,
    });
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
