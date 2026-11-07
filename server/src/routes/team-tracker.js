import { Router } from "express";
import { pool } from "../db.js";
import { editorRanks, seesEditor, taskViewer } from "../hierarchy.js";
import { scoreMonthAll } from "../goal-score.js";
import { istNow } from "../attendance.js";
import { jobCount } from "../job-count.js";
import { hasColumn } from "../schema-flags.js";

// Team tracker (pages/team-tracker.tsx): for the Managers, Asst. Managers and
// Team Leads (and the Super Admin and admins) — their team, each person's month
// at a glance, and one person's profile and task history. Who's listed follows
// the Task Board's rule (../hierarchy.js seesEditor): your level and below.
//   GET /team-tracker?month=YYYY-MM          the people
//   GET /team-tracker/:editorId?month=YYYY-MM one person
export const teamTrackerRouter = Router();

const REF = "coalesce(t.sid, regexp_replace(t.ad_id, '^AdID', 'AID', 'i'), t.svid, t.pid, t.tid)";
const IN_MONTH = (col, p) => `${col} >= (${p}::date)::timestamp at time zone 'Asia/Kolkata'
  and ${col} < (${p}::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`;
const monthFirst = (q) => (/^\d{4}-\d{2}$/.test(String(q ?? "")) ? `${q}-01` : `${istNow().ymd.slice(0, 7)}-01`);
const tenth = (n) => Math.round(Number(n || 0) * 10) / 10;

async function access(req) {
  const viewer = await taskViewer(req);
  return { viewer, ok: viewer.seesAll || viewer.admin || viewer.rank <= 2 };
}
const NOT_YOURS = "Team tracker is for the Managers, Asst. Managers and Team Leads.";

teamTrackerRouter.get("/team-tracker", async (req, res, next) => {
  try {
    const { viewer, ok } = await access(req);
    if (!ok) return res.status(403).json({ error: NOT_YOURS });
    const month = monthFirst(req.query.month);
    const today = istNow().ymd;
    const [ranks, people, done, open, day, leave, scores] = await Promise.all([
      editorRanks(req.orgId),
      pool.query(
        `select e.id, e.name, e.designation, e.image_url as "imageUrl", e.employee_code as code
           from editor e where e.org_id = $1 and e.active order by lower(e.name)`,
        [req.orgId],
      ),
      // the month's work done: bulk work as its jobs (../job-count.js), posting copies not at all
      pool.query(
        `select t.editor_id as id, sum(${jobCount("t")})::int as n
           from task t
          where t.org_id = $1 and t.status = 'done' and t.editor_id is not null and coalesce(t.meta->>'postsFor', '') = ''
            and ${IN_MONTH("t.completed_at", "$2")}
          group by 1`,
        [req.orgId, month],
      ),
      pool.query(
        `select t.editor_id as id, count(*)::int as open, (count(*) filter (where t.due_date < $2::date))::int as overdue
           from task t where t.org_id = $1 and t.status <> 'done' and t.editor_id is not null and coalesce(t.meta->>'postsFor', '') = ''
          group by 1`,
        [req.orgId, today],
      ),
      // today: working (a day open), done for the day, or not started
      pool.query(
        `select editor_id as id, bool_or(ended_at is null) as working, min(started_at) as "startedAt"
           from eod_session where org_id = $1 and date = $2::date group by 1`,
        [req.orgId, today],
      ),
      (await hasColumn("attendance", "id"))
        ? pool.query("select editor_id as id, status from attendance where org_id = $1 and date = $2::date and status in ('leave', 'half_day')", [req.orgId, today])
        : { rows: [] },
      scoreMonthAll(req.orgId, month),
    ]);
    const doneOf = new Map(done.rows.map((r) => [r.id, r.n]));
    const openOf = new Map(open.rows.map((r) => [r.id, r]));
    const dayOf = new Map(day.rows.map((r) => [r.id, r]));
    const leaveOf = new Map(leave.rows.map((r) => [r.id, r.status]));
    const list = people.rows
      .filter((p) => (ranks.get(p.id) ?? 3) < 4 && seesEditor(viewer, ranks, p.id))
      .map((p) => {
        const s = scores.get(p.id);
        const d = dayOf.get(p.id);
        return {
          ...p, rank: ranks.get(p.id) ?? 3, me: p.id === viewer.editorId,
          done: doneOf.get(p.id) ?? 0, open: openOf.get(p.id)?.open ?? 0, overdue: openOf.get(p.id)?.overdue ?? 0,
          pct: s?.pct == null ? null : tenth(s.pct),
          today: leaveOf.get(p.id) ?? (d ? (d.working ? "working" : "ended") : "not_started"),
          startedAt: d?.startedAt ?? null,
        };
      })
      // the most senior first, then by name
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    res.json({ month: month.slice(0, 7), people: list });
  } catch (err) { next(err); }
});

teamTrackerRouter.get("/team-tracker/:editorId", async (req, res, next) => {
  try {
    const { viewer, ok } = await access(req);
    if (!ok) return res.status(403).json({ error: NOT_YOURS });
    const id = req.params.editorId;
    const ranks = await editorRanks(req.orgId);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !ranks.has(id) || !seesEditor(viewer, ranks, id)) {
      return res.status(404).json({ error: "Not someone on your team." });
    }
    const month = monthFirst(req.query.month);
    const thisMonth = month.slice(0, 7) === istNow().ymd.slice(0, 7);
    const teams = await hasColumn("ad_team", "id");
    const [profile, brands, scores, att, worked, tasks, backs] = await Promise.all([
      pool.query(
        `select e.id, e.name, e.designation, e.image_url as "imageUrl", e.employee_code as code, e.active, e.created_at as "since",
                le.name as "leadName", u.email, u.active as "loginOn"
           from editor e
           left join editor le on le.id = e.lead_editor_id
           left join app_user u on u.editor_id = e.id
          where e.id = $1 and e.org_id = $2
          order by u.created_at limit 1`,
        [id, req.orgId],
      ),
      pool.query(
        `select distinct w.name from app_user u join membership m on m.user_id = u.id
           join workspace w on w.id = m.workspace_id and w.org_id = $2
          where u.editor_id = $1 order by w.name`,
        [id, req.orgId],
      ),
      scoreMonthAll(req.orgId, month, id),
      (await hasColumn("attendance", "id"))
        ? pool.query(
          `select status, count(*)::int as n from attendance
            where org_id = $1 and editor_id = $2 and date >= $3::date and date < ($3::date + interval '1 month') group by 1`,
          [req.orgId, id, month],
        )
        : { rows: [] },
      pool.query(
        `select coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))), 0)::float / 3600 as hours, count(distinct date)::int as days
           from eod_session where org_id = $1 and editor_id = $2 and date >= $3::date and date < ($3::date + interval '1 month')`,
        [req.orgId, id, month],
      ),
      // the month's work: what was done in it, and (this month) what's open now
      pool.query(
        `select t.id, ${REF} as ref, t.title, t.status, t.task_type as "taskType", t.on_hold as "onHold", t.revision,
                t.due_date::text as due, t.completed_at as "completedAt", t.created_at as "createdAt",
                cf.name as "typeName", cf.icon as "typeIcon",
                coalesce(w.name${teams ? ", (select a.name from ad_team a where a.id = (to_jsonb(t)->>'ad_team_id')::uuid)" : ""}) as brand,
                (case when t.status = 'done' then coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points) else cf.points end)::float as points,
                ${jobCount("t")} as jobs, t.budget_hours::float as "budgetHours",
                ((coalesce(t.budget_used_seconds, 0)
                  + case when t.budget_started_at is not null then extract(epoch from (coalesce(t.completed_at, now()) - t.budget_started_at)) else 0 end) / 3600.0)::float as "hoursUsed",
                t.delivery_link as "deliveryLink",
                (t.status = 'done' and t.due_date is not null and (t.completed_at at time zone 'Asia/Kolkata')::date > t.due_date) as late,
                (t.assigned_by is not null) as given
           from task t
           left join task_content_format cf on cf.id = t.content_format_id
           left join workspace w on w.id = t.channel_id
          where t.org_id = $1 and t.editor_id = $2 and coalesce(t.meta->>'postsFor', '') = ''
            and ((t.status = 'done' and ${IN_MONTH("t.completed_at", "$3")}) or ($4 and t.status <> 'done'))
          order by (t.status = 'done'), coalesce(t.completed_at, t.created_at) desc
          limit 400`,
        [req.orgId, id, month, thisMonth],
      ),
      pool.query(
        `select count(*)::int as n from task_review_log l join task t on t.id = l.task_id
          where t.org_id = $1 and t.editor_id = $2 and l.action = 'sent_back' and ${IN_MONTH("l.created_at", "$3")}`,
        [req.orgId, id, month],
      ),
    ]);
    const p = profile.rows[0];
    if (!p) return res.status(404).json({ error: "Not someone on your team." });
    const s = scores.get(id);
    const doneRows = tasks.rows.filter((t) => t.status === "done");
    const attendance = Object.fromEntries(att.rows.map((r) => [r.status, r.n]));
    res.json({
      month: month.slice(0, 7),
      profile: { ...p, rank: ranks.get(id) ?? 3, brands: brands.rows.map((b) => b.name), email: p.email ?? null },
      score: s ? {
        pct: s.pct == null ? null : tenth(s.pct), goalPoints: tenth(s.goalPoints), reached: tenth(s.reached),
        types: (s.types ?? []).filter((x) => x.goalJC > 0 || x.done > 0).map((x) => ({ name: x.name, icon: x.icon ?? null, goal: tenth(x.goal), done: x.done })),
        otherHours: tenth(s.otherHours), creditHours: tenth(s.creditHours),
      } : null,
      totals: {
        done: doneRows.reduce((n, t) => n + (Number(t.jobs) || 1), 0),
        points: tenth(doneRows.reduce((n, t) => n + (Number(t.points) || 0) * (Number(t.jobs) || 1), 0)),
        late: doneRows.filter((t) => t.late).length,
        onTime: doneRows.filter((t) => !t.late && t.due).length,
        sentBack: backs.rows[0]?.n ?? 0,
        open: tasks.rows.filter((t) => t.status !== "done").length,
        hoursWorked: tenth(worked.rows[0]?.hours), daysWorked: worked.rows[0]?.days ?? 0,
        attendance,
      },
      tasks: tasks.rows.map((t) => ({ ...t, hoursUsed: tenth(t.hoursUsed) })),
    });
  } catch (err) { next(err); }
});
