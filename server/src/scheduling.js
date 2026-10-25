import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { istNow } from "./attendance.js";

// Social tasks after approval (20261104120000_task_scheduling). An approved
// Social task of a brand with a scheduler goes to that person: they set the post
// date, post it, and LINK_AFTER_DAYS later paste each platform's link — each link
// becomes a post on the same SID, with the task's brand, title, date and editor
// (routes/scheduling.js). The editor's credit is the approval itself, as before.

export const schedulingReady = () => hasColumn("post", "from_task_id");
export const NEEDS_SCHED_DB = "Scheduling needs a database update first — ask whoever runs the database to apply 20261104120000_task_scheduling.";

// The links are asked for this many days after the post date (the numbers have settled).
export const LINK_AFTER_DAYS = 2;

export function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Where a task stands in scheduling, or null when it isn't in it:
// to_schedule (no date yet) · scheduled (date set) · links_due (LINK_AFTER_DAYS
// past the date, no link) · live (a link is in). t: schedule_from, post_on, linked_posts.
export function scheduleStage(t, today = istNow().ymd) {
  if (!t?.schedule_from || t.status !== "done") return null;
  if ((t.linked_posts ?? 0) > 0) return "live";
  if (!t.post_on) return "to_schedule";
  return today >= addDaysYmd(t.post_on, LINK_AFTER_DAYS) ? "links_due" : "scheduled";
}

// Just approved (or closed without review): a Social task — not one made from a
// post, which is a post already — of a brand with a scheduler goes to them.
// Returns the scheduler's editor id, or null when it doesn't go into scheduling.
export async function enterScheduling(taskId) {
  if (!(await schedulingReady())) return null;
  const { rows } = await pool.query(
    `update task t set schedule_from = now(), scheduler_id = coalesce(t.scheduler_id, w.scheduler_id)
       from workspace w
      where t.id = $1 and w.id = t.channel_id and t.task_type = 'social' and t.post_id is null
        and t.schedule_from is null and w.scheduler_id is not null
      returning t.scheduler_id`,
    [taskId],
  );
  return rows[0]?.scheduler_id ?? null;
}

// Reopened before any link went in: out of scheduling (its date with it); it
// goes back to the scheduler when it's approved again. Once a post was made
// from it, it stays — the posts are real.
export async function leaveScheduling(taskId) {
  if (!(await schedulingReady())) return;
  await pool.query(
    `update task set schedule_from = null, post_on = null, post_time = null
      where id = $1 and schedule_from is not null
        and not exists (select 1 from post p where p.from_task_id = task.id and p.deleted_at is null)`,
    [taskId],
  );
}

// "https://www.instagram.com/reel/ABC/?igsh=x" and ".../reel/ABC" are the same post.
export function sameLink(url) {
  return String(url || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}
