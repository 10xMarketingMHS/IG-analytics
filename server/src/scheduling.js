import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Social tasks after approval (20261104120000_task_scheduling). An approved
// Social task goes into one shared list for the schedulers — anyone with a
// Schedule goal this month (Goals › Set goals). Whoever sets its post date
// takes it; they post it, and LINK_AFTER_DAYS later paste each platform's link —
// each link becomes a post on the same SID (routes/scheduling.js), and the
// scheduling counts as one Schedule job of theirs. The editor's credit is the
// approval itself, as before.

export const schedulingReady = () => hasColumn("post", "from_task_id");
export const NEEDS_SCHED_DB = "Scheduling needs a database update first — ask whoever runs the database to apply 20261104120000_task_scheduling.";

// The links are asked for this many days after the post date (the numbers have settled).
export const LINK_AFTER_DAYS = 2;

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Where a task stands in scheduling, or null when it isn't in it:
// to_schedule (no date yet) · scheduled (date set) · links_due (LINK_AFTER_DAYS
// past the date, no link) · live (a link is in). t: schedule_from, post_on, linked_posts.
export function scheduleStage(t, today = todayIst()) {
  if (!t?.schedule_from || t.status !== "done") return null;
  if ((t.linked_posts ?? 0) > 0) return "live";
  if (!t.post_on) return "to_schedule";
  return today >= addDaysYmd(t.post_on, LINK_AFTER_DAYS) ? "links_due" : "scheduled";
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

// Just approved (or closed without review): a Social task — not one made from a
// post, which is a post already — goes into the schedulers' shared list.
// True when it did.
export async function enterScheduling(taskId) {
  if (!(await schedulingReady())) return false;
  const { rowCount } = await pool.query(
    `update task set schedule_from = now(), scheduler_id = null, post_on = null, post_time = null
      where id = $1 and task_type = 'social' and post_id is null and schedule_from is null`,
    [taskId],
  );
  return rowCount > 0;
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
