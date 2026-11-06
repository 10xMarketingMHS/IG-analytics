import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Social tasks after approval (20261104120000_task_scheduling). An approved
// Social task whose type is ticked "Goes to Scheduling" (Settings › Tasks &
// time: Reels, Carousel, Post — not Thumbnail; a task with no type stays out)
// goes into one shared list for the schedulers — anyone with a
// Schedule goal this month (Goals › Set goals). Whoever sets its post date
// takes it; they post it, and within LINK_AFTER_DAYS paste each platform's link —
// each link becomes a post on the same SID (routes/scheduling.js), and the
// scheduling counts as one Schedule job of theirs. The editor's credit is the
// approval itself, as before.

export const schedulingReady = async () => (await hasColumn("post", "from_task_id")) && hasColumn("task_content_format", "to_scheduling");
export const NEEDS_SCHED_DB = "Scheduling needs a database update first — ask whoever runs the database to apply 20261104120000_task_scheduling.";

// Two days to paste the links once it's out: they're due by 11:59 PM (IST) on
// the post date + LINK_AFTER_DAYS. The countdown runs from the moment the date is set.
export const LINK_AFTER_DAYS = 2;
export const linksDueAt = (postOn) => `${addDaysYmd(postOn, LINK_AFTER_DAYS)}T23:59:59+05:30`;

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Where a task stands in scheduling, or null when it isn't in it:
// to_schedule (no date yet) · scheduled (date set, before the day) · links_due
// (from the post day on, no link yet) · live (a link is in). t: schedule_from, post_on, linked_posts.
export function scheduleStage(t, today = todayIst()) {
  if (!t?.schedule_from || t.status !== "done") return null;
  if ((t.linked_posts ?? 0) > 0) return "live";
  if (!t.post_on) return "to_schedule";
  return today >= t.post_on ? "links_due" : "scheduled";
}

// The org's Schedule content type — the goal that makes someone a scheduler,
// and the type their scheduling counts as.
export async function scheduleFormat(orgId) {
  const { rows } = await pool.query(
    `select id, name, category, points from task_content_format
      where org_id = $1 and active and lower(trim(name)) in ('schedule', 'scheduling') order by created_at limit 1`,
    [orgId],
  );
  return rows[0] ?? null;
}
// Who schedules this month: everyone with a Schedule goal (editor ids).
export async function schedulerIds(orgId) {
  const { rows } = await pool.query(
    `select distinct g.editor_id from editor_goal g join task_content_format cf on cf.id = g.content_format_id
      where g.org_id = $1 and g.period_month = date_trunc('month', now() at time zone 'Asia/Kolkata')::date
        and lower(trim(cf.name)) in ('schedule', 'scheduling')
        and (coalesce(g.jc, 0) > 0 or coalesce((to_jsonb(g)->>'points')::numeric, 0) > 0)`,
    [orgId],
  );
  return rows.map((r) => r.editor_id);
}
export async function isScheduler(orgId, editorId) {
  return !!editorId && (await schedulerIds(orgId)).includes(editorId);
}

// Just approved (or closed without review): a Social task of a type that goes
// to Scheduling — not one made from a post, which is a post already — goes into
// the schedulers' shared list. True when it did.
export async function enterScheduling(taskId) {
  if (!(await schedulingReady())) return false;
  const { rowCount } = await pool.query(
    `update task set schedule_from = now(), scheduler_id = null, post_on = null, post_time = null
      where id = $1 and task_type = 'social' and post_id is null and schedule_from is null
        and exists (select 1 from task_content_format f where f.id = task.content_format_id and f.to_scheduling)`,
    [taskId],
  );
  return rowCount > 0;
}

// A type's tick changed (Settings › Tasks & time), and the list follows it.
// Ticked: this month's approved Social work of the type comes in, as the
// database update brought it in. Unticked: what's waiting untaken goes out —
// work someone took, or that has its links, stays with them.
export async function followTypeTick(orgId, formatId, on) {
  if (!(await schedulingReady())) return 0;
  const { rowCount } = on
    ? await pool.query(
      `update task set schedule_from = completed_at, scheduler_id = null, post_on = null, post_time = null
        where org_id = $1 and content_format_id = $2 and task_type = 'social' and post_id is null and status = 'done'
          and schedule_from is null and completed_at is not null
          and completed_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`,
      [orgId, formatId],
    )
    : await pool.query(
      `update task set schedule_from = null, post_on = null, post_time = null
        where org_id = $1 and content_format_id = $2 and schedule_from is not null and scheduler_id is null
          and not exists (select 1 from post p where p.from_task_id = task.id and p.deleted_at is null)`,
      [orgId, formatId],
    );
  return rowCount;
}

// Reopened before any link went in: out of scheduling (its date and taker with
// it); it goes back into the list when it's approved again. Once a post was
// made from it, it stays — the posts are real.
export async function leaveScheduling(taskId) {
  if (!(await schedulingReady())) return;
  await pool.query(
    `update task set schedule_from = null, post_on = null, post_time = null, scheduler_id = null
      where id = $1 and schedule_from is not null
        and not exists (select 1 from post p where p.from_task_id = task.id and p.deleted_at is null)`,
    [taskId],
  );
}

// "https://www.instagram.com/reel/ABC/?igsh=x" and ".../reel/ABC" are the same post.
export function sameLink(url) {
  return String(url || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

// What each scheduler scheduled on a day, by brand: the work whose post date was
// first set that day (its schedule_set activity), still dated and still theirs.
// A re-date later doesn't count it again; a posting copy for another brand
// (meta.postsFor) is its own post, so it counts for that brand. editorId: just theirs.
export async function scheduledOn(orgId, day, editorId = null) {
  const { rows } = await pool.query(
    `select x.scheduler_id as "editorId", e.name, w.id as "brandId", coalesce(w.name, 'No brand') as brand, count(*)::int as n
       from task x
       join editor e on e.id = x.scheduler_id
       left join workspace w on w.id = x.channel_id
      where x.org_id = $1 and x.schedule_from is not null and x.post_on is not null
        and ($3::uuid is null or x.scheduler_id = $3::uuid)
        and (select min(a.created_at at time zone 'Asia/Kolkata')::date from activity a
              where a.org_id = $1 and a.entity_id = x.id and a.verb = 'schedule_set' and a.meta->>'postOn' is not null) = $2::date
      group by 1, 2, 3, 4
      order by e.name, n desc, brand`,
    [orgId, day, editorId],
  );
  // one line per scheduler: their total, then each brand
  const out = new Map();
  for (const r of rows) {
    const p = out.get(r.editorId) ?? { editorId: r.editorId, name: r.name, total: 0, brands: [] };
    p.total += r.n;
    p.brands.push({ brandId: r.brandId, brand: r.brand, n: r.n });
    out.set(r.editorId, p);
  }
  return [...out.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
// A scheduler's day for the End of Day report (routes/eod.js): what they
// scheduled (by brand), what went live with its links that day, and their
// Schedule task's desk counts. null when there's nothing and they don't schedule.
export async function schedulingDay(orgId, editorId, date) {
  if (!editorId || !(await schedulingReady())) return null;
  const [dated, live, desk, sched] = await Promise.all([
    scheduledOn(orgId, date, editorId),
    pool.query(
      `select count(*)::int as n from post p join task x on x.id = p.from_task_id
        where x.org_id = $1 and x.scheduler_id = $2 and p.deleted_at is null
          and (p.created_at at time zone 'Asia/Kolkata')::date = $3::date`,
      [orgId, editorId, date],
    ),
    scheduleFormat(orgId).then((sf) => (sf ? pool.query(
      `select coalesce(sum((meta->'desk'->>'comments')::int), 0)::int as comments,
              coalesce(sum((meta->'desk'->>'leads')::int), 0)::int as leads, bool_or(meta ? 'desk') as has
         from task where org_id = $1 and editor_id = $2 and content_format_id = $3
          and coalesce(due_date, (created_at at time zone 'Asia/Kolkata')::date) = $4::date`,
      [orgId, editorId, sf.id, date],
    ) : { rows: [{ comments: 0, leads: 0, has: false }] })),
    isScheduler(orgId, editorId),
  ]);
  const scheduled = dated[0] ? { total: dated[0].total, brands: dated[0].brands.map(({ brand, n }) => ({ brand, n })) } : { total: 0, brands: [] };
  const d = desk.rows[0] ?? {};
  const out = { scheduled, live: live.rows[0]?.n ?? 0, comments: d.comments ?? 0, leads: d.leads ?? 0, desk: !!d.has };
  if (!sched && !out.scheduled.total && !out.live && !out.desk) return null;
  return out;
}
