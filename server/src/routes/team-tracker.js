import { Router } from "express";
import { pool } from "../db.js";
import { editorRanks, seesEditor, taskViewer } from "../hierarchy.js";
import { scoreMonthAll } from "../goal-score.js";
import { istNow } from "../attendance.js";
import { jobCount } from "../job-count.js";
import { hasColumn } from "../schema-flags.js";
import { withReview } from "../review-route.js";

// Team tracker (pages/team-tracker.tsx): for the Managers, Asst. Managers and
// Team Leads (and the Super Admin and admins) — their team, each person's
// numbers for a month or any dates, and one person's profile and task history.
// Who's listed follows the Task Board's rule (../hierarchy.js seesEditor):
// your level and below.
//   GET /team-tracker?month=YYYY-MM | ?from=YYYY-MM-DD&to=YYYY-MM-DD   the people
//   GET /team-tracker/:editorId?(the same)                             one person
// Goal % is the month's (the month the dates start in): goals are monthly.
export const teamTrackerRouter = Router();

const REF = "coalesce(t.sid, regexp_replace(t.ad_id, '^AdID', 'AID', 'i'), t.svid, t.pid, t.tid)";
// a timestamp within the dates, by India time; $from and $to are 'YYYY-MM-DD', both days included
const IN_DAYS = (col, from, to) => `${col} >= (${from}::date)::timestamp at time zone 'Asia/Kolkata'
  and ${col} < (${to}::date + 1)::timestamp at time zone 'Asia/Kolkata'`;
const tenth = (n) => Math.round(Number(n || 0) * 10) / 10;
// Today's break so far for a person (the editor row, `e`, ./breaks.js): what's
// banked plus the break under way, up to the day's 75 minutes; and on it right now.
const BREAK_CAP = 75 * 60;
const BREAK_TODAY = `(case when e.break_date = (now() at time zone 'Asia/Kolkata')::date
    then least(${BREAK_CAP}, coalesce(e.break_used_seconds, 0)
      + case when e.break_started_at is not null then greatest(0, extract(epoch from now() - e.break_started_at)) else 0 end)
    else 0 end)`;
const ON_BREAK = `(e.break_date = (now() at time zone 'Asia/Kolkata')::date and e.break_started_at is not null
    and coalesce(e.break_used_seconds, 0) + extract(epoch from now() - e.break_started_at) < ${BREAK_CAP})`;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const lastDay = (first) => { const d = new Date(`${first}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };

// the dates asked for: from–to (at most a year), else a month, else this month
function periodOf(q) {
  const today = istNow().ymd;
  if (YMD.test(String(q.from ?? "")) && YMD.test(String(q.to ?? "")) && q.from <= q.to
      && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366) {
    return { from: q.from, to: q.to, month: `${q.from.slice(0, 7)}-01`, dates: true, today, live: q.to >= today };
  }
  const first = /^\d{4}-\d{2}$/.test(String(q.month ?? "")) ? `${q.month}-01` : `${today.slice(0, 7)}-01`;
  const to = lastDay(first);
  return { from: first, to, month: first, dates: false, today, live: to >= today };
}

async function access(req) {
  const viewer = await taskViewer(req);
  return { viewer, ok: viewer.seesAll || viewer.admin || viewer.rank <= 2 };
}
const NOT_YOURS = "Team tracker is for the Managers, Asst. Managers and Team Leads.";

teamTrackerRouter.get("/team-tracker", async (req, res, next) => {
  try {
    const { viewer, ok } = await access(req);
    if (!ok) return res.status(403).json({ error: NOT_YOURS });
    const P = periodOf(req.query);
    const breakCounts = await hasColumn("attendance", "break_count");
    const [ranks, people, done, open, day, leave, scores, breaksToday] = await Promise.all([
      editorRanks(req.orgId),
      pool.query(
        `select e.id, e.name, e.designation, e.image_url as "imageUrl", e.employee_code as code,
                round(${BREAK_TODAY})::int as "breakSeconds", ${ON_BREAK} as "onBreak"
           from editor e where e.org_id = $1 and e.active order by lower(e.name)`,
        [req.orgId],
      ),
      // the work done in the dates: bulk work as its jobs (../job-count.js), posting copies not at all
      pool.query(
        `select t.editor_id as id, sum(${jobCount("t")})::int as n
           from task t
          where t.org_id = $1 and t.status = 'done' and t.editor_id is not null and coalesce(t.meta->>'postsFor', '') = ''
            and ${IN_DAYS("t.completed_at", "$2", "$3")}
          group by 1`,
        [req.orgId, P.from, P.to],
      ),
      pool.query(
        `select t.editor_id as id, count(*)::int as open, (count(*) filter (where t.due_date < $2::date))::int as overdue
           from task t where t.org_id = $1 and t.status <> 'done' and t.editor_id is not null and coalesce(t.meta->>'postsFor', '') = ''
          group by 1`,
        [req.orgId, P.today],
      ),
      // today: working (a day open), done for the day, or not started
      pool.query(
        `select editor_id as id, bool_or(ended_at is null) as working, min(started_at) as "startedAt"
           from eod_session where org_id = $1 and date = $2::date group by 1`,
        [req.orgId, P.today],
      ),
      (await hasColumn("attendance", "id"))
        ? pool.query("select editor_id as id, status from attendance where org_id = $1 and date = $2::date and status in ('leave', 'half_day')", [req.orgId, P.today])
        : { rows: [] },
      scoreMonthAll(req.orgId, P.month),
      // how many breaks today (kept on the day's attendance row, ./breaks.js)
      breakCounts
        ? pool.query("select editor_id as id, break_count as n from attendance where org_id = $1 and date = $2::date", [req.orgId, P.today])
        : { rows: [] },
    ]);
    const breaksOf = new Map(breaksToday.rows.map((r) => [r.id, r.n]));
    const doneOf = new Map(done.rows.map((r) => [r.id, r.n]));
    const openOf = new Map(open.rows.map((r) => [r.id, r]));
    const dayOf = new Map(day.rows.map((r) => [r.id, r]));
    const leaveOf = new Map(leave.rows.map((r) => [r.id, r.status]));
    const list = people.rows
      .filter((p) => (ranks.get(p.id) ?? 3) < 4 && seesEditor(viewer, ranks, p.id))
      .map(({ breakSeconds, onBreak, ...p }) => {
        const s = scores.get(p.id);
        const d = dayOf.get(p.id);
        return {
          ...p, rank: ranks.get(p.id) ?? 3, me: p.id === viewer.editorId,
          // today's break: minutes so far (of 75), on one now, and how many
          breakToday: { minutes: Math.round((breakSeconds ?? 0) / 60), onBreak: !!onBreak, count: breakCounts ? breaksOf.get(p.id) ?? 0 : null },
          done: doneOf.get(p.id) ?? 0, open: openOf.get(p.id)?.open ?? 0, overdue: openOf.get(p.id)?.overdue ?? 0,
          pct: s?.pct == null ? null : tenth(s.pct),
          today: leaveOf.get(p.id) ?? (d ? (d.working ? "working" : "ended") : "not_started"),
          startedAt: d?.startedAt ?? null,
        };
      })
      // the most senior first, then by name
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    res.json({ from: P.from, to: P.to, month: P.month.slice(0, 7), dates: P.dates, people: list });
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
    const P = periodOf(req.query);
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
      scoreMonthAll(req.orgId, P.month, id),
      (await hasColumn("attendance", "id"))
        ? pool.query(
          `select status, count(*)::int as n from attendance
            where org_id = $1 and editor_id = $2 and date >= $3::date and date <= $4::date group by 1`,
          [req.orgId, id, P.from, P.to],
        )
        : { rows: [] },
      pool.query(
        `select coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))), 0)::float / 3600 as hours, count(distinct date)::int as days
           from eod_session where org_id = $1 and editor_id = $2 and date >= $3::date and date <= $4::date`,
        [req.orgId, id, P.from, P.to],
      ),
      // the work: what was done in the dates and, when they reach today, what's open now —
      // each with who approved it (or that its person closed it), and its trips back and forth
      pool.query(
        `select t.id, ${REF} as ref, t.title, t.status, t.task_type as "taskType", t.on_hold as "onHold", t.revision,
                t.editor_id, t.assigned_by, t.content_format_id, t.review_started_at,
                t.due_date::text as due, t.completed_at as "completedAt", t.created_at as "createdAt",
                cf.name as "typeName", cf.icon as "typeIcon",
                coalesce(w.name${teams ? ", (select a.name from ad_team a where a.id = (to_jsonb(t)->>'ad_team_id')::uuid)" : ""}) as brand,
                (case when t.status = 'done' then coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points) else cf.points end)::float as points,
                ${jobCount("t")} as jobs, t.budget_hours::float as "budgetHours",
                ((coalesce(t.budget_used_seconds, 0)
                  + case when t.budget_started_at is not null then extract(epoch from (coalesce(t.completed_at, now()) - t.budget_started_at)) else 0 end) / 3600.0)::float as "hoursUsed",
                t.delivery_link as "deliveryLink",
                (t.status = 'done' and t.due_date is not null and (t.completed_at at time zone 'Asia/Kolkata')::date > t.due_date) as late,
                (t.assigned_by is not null) as given,
                ap.name as "approvedBy", coalesce(ap.self, false) as "closedBySelf", ap.at as "approvedAt",
                (select count(*)::int from task_review_log l where l.task_id = t.id and l.action = 'sent_back') as "sentBacks",
                (select count(*)::int from activity a where a.entity_id = t.id and a.verb = 'review_requested') as "submissions"
           from task t
           left join task_content_format cf on cf.id = t.content_format_id
           left join workspace w on w.id = t.channel_id
           left join lateral (
             select coalesce(re.name, ru.name, ru.email) as name, (ru.editor_id is not null and ru.editor_id = t.editor_id) as self, l.created_at as at
               from task_review_log l join app_user ru on ru.id = l.actor_id left join editor re on re.id = ru.editor_id
              where l.task_id = t.id and l.action = 'approved'
              order by l.created_at desc limit 1
           ) ap on t.status = 'done'
          where t.org_id = $1 and t.editor_id = $2 and coalesce(t.meta->>'postsFor', '') = ''
            and ((t.status = 'done' and ${IN_DAYS("t.completed_at", "$3", "$4")}) or ($5 and t.status <> 'done'))
          order by (t.status = 'done'), coalesce(t.completed_at, t.created_at) desc
          limit 400`,
        [req.orgId, id, P.from, P.to, P.live],
      ),
      pool.query(
        `select count(*)::int as n from task_review_log l join task t on t.id = l.task_id
          where t.org_id = $1 and t.editor_id = $2 and l.action = 'sent_back' and ${IN_DAYS("l.created_at", "$3", "$4")}`,
        [req.orgId, id, P.from, P.to],
      ),
    ]);
    const p = profile.rows[0];
    if (!p) return res.status(404).json({ error: "Not someone on your team." });
    // Each day of the dates, and today: when they started and ended, the hours,
    // their attendance and their break (kept on the attendance row, ./breaks.js;
    // today's from the editor row, as it stands)
    const hasAtt = await hasColumn("attendance", "id");
    const breaksKept = hasAtt && (await hasColumn("attendance", "break_seconds"));
    const SESS = `select date::text as day, min(started_at) as "startedAt", max(ended_at) as "endedAt", bool_or(ended_at is null) as open,
                         coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))), 0)::float / 3600 as hours
                    from eod_session where org_id = $1 and editor_id = $2 and date >= $3::date and date <= $4::date group by 1`;
    const ATT = `select date::text as day, status, late_minutes as "lateMinutes"${breaksKept ? `, break_seconds as "breakSeconds", break_count as breaks` : ""}
                   from attendance where org_id = $1 and editor_id = $2 and date >= $3::date and date <= $4::date`;
    const [sessDays, attDays, sessToday, attToday, breakNow, working] = await Promise.all([
      pool.query(SESS, [req.orgId, id, P.from, P.to]),
      hasAtt ? pool.query(ATT, [req.orgId, id, P.from, P.to]) : { rows: [] },
      pool.query(SESS, [req.orgId, id, P.today, P.today]),
      hasAtt ? pool.query(ATT, [req.orgId, id, P.today, P.today]) : { rows: [] },
      pool.query(`select round(${BREAK_TODAY})::int as "breakSeconds", ${ON_BREAK} as "onBreak" from editor e where e.id = $1`, [id]),
      pool.query(
        `select ${REF} as ref, t.title from task t
          where t.org_id = $1 and t.editor_id = $2 and t.status = 'in_progress' and not coalesce(t.on_hold, false)
          order by t.budget_started_at desc nulls last limit 3`,
        [req.orgId, id],
      ),
    ]);
    const liveBreak = breakNow.rows[0] ?? { breakSeconds: 0, onBreak: false };
    const sessOf = new Map(sessDays.rows.map((r) => [r.day, r]));
    const attOf = new Map(attDays.rows.map((r) => [r.day, r]));
    const days = [...new Set([...sessOf.keys(), ...attOf.keys()])].filter((d) => d <= P.today).sort().reverse().map((day) => {
      const sx = sessOf.get(day), ax = attOf.get(day);
      const brk = day === P.today ? Math.max(liveBreak.breakSeconds ?? 0, ax?.breakSeconds ?? 0) : ax?.breakSeconds ?? null;
      return {
        day, status: ax?.status ?? null, lateMinutes: ax?.lateMinutes ?? 0,
        startedAt: sx?.startedAt ?? null, endedAt: sx && !sx.open ? sx.endedAt : null, open: !!sx?.open, hours: tenth(sx?.hours),
        breakMinutes: brk == null ? null : Math.round(brk / 60), breaks: ax?.breaks ?? null,
      };
    });
    const st = sessToday.rows[0], at = attToday.rows[0];
    const today = {
      day: P.today, status: at?.status ?? null, lateMinutes: at?.lateMinutes ?? 0,
      startedAt: st?.startedAt ?? null, endedAt: st && !st.open ? st.endedAt : null, working: !!st?.open, hours: tenth(st?.hours),
      breakMinutes: Math.round(Math.max(liveBreak.breakSeconds ?? 0, at?.breakSeconds ?? 0) / 60), breakCapMinutes: BREAK_CAP / 60,
      breaks: breaksKept ? at?.breaks ?? 0 : null, onBreak: !!liveBreak.onBreak,
      current: working.rows,
    };
    const breakMinutes = days.reduce((n, d) => n + (d.breakMinutes ?? 0), 0);
    const daysAtWork = days.filter((d) => d.startedAt).length;
    // in review: who it's waiting for (../review-route.js)
    await withReview(req, tasks.rows);
    const s = scores.get(id);
    const doneRows = tasks.rows.filter((t) => t.status === "done");
    const attendance = Object.fromEntries(att.rows.map((r) => [r.status, r.n]));
    res.json({
      from: P.from, to: P.to, month: P.month.slice(0, 7), dates: P.dates, live: P.live,
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
        // the dates' breaks: minutes in all, and a day's on average (the days they worked)
        breakMinutes, breakAvgMinutes: daysAtWork ? Math.round(breakMinutes / daysAtWork) : null,
      },
      today, days,
      tasks: tasks.rows.map(({ editor_id, assigned_by, content_format_id, review_started_at, can_review, review_by, ...t }) => ({
        ...t, hoursUsed: tenth(t.hoursUsed), waitingFor: t.status === "review" ? t.review_names ?? review_by ?? null : null,
      })),
    });
  } catch (err) { next(err); }
});
