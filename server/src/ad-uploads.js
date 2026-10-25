import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Ad uploads (20261106120000_ad_uploads): an approved Ad task whose type is
// ticked to go on after approval (Settings › Tasks & time) waits in one list
// for the Managers and Team Leads. They record which ads it became — the AD
// number Animus gave it for the VSL team, or the ad's name or number the other
// teams send back — one task, one or more ads (task_ad). Record-keeping only:
// no job credit. Each team is a brand, so an ad's name is unique per brand.

export const uploadsReady = async () => (await hasColumn("task", "upload_from")) && hasColumn("task_content_format", "to_scheduling");
export const NEEDS_UPLOADS_DB = "Ad uploads needs a database update first — ask whoever runs the database to apply 20261106120000_ad_uploads.";

// to_upload (no ad recorded yet) · uploaded (one or more) — null when it isn't in the list.
export function uploadStage(t) {
  if (!t?.upload_from || t.status !== "done") return null;
  return (t.ad_count ?? 0) > 0 ? "uploaded" : "to_upload";
}

// "ad 205", "AD0205", "Ad205" → "AD205" (Animus pads to three digits: AD026);
// anything else is kept as typed, spaces tidied: another team's ad name.
export function adRefOf(raw) {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  const n = s.match(/^ad\s*0*(\d+)$/i);
  return n ? `AD${n[1].padStart(3, "0")}` : s;
}

// Just approved (or closed without review): an Ad task of a type that goes on
// comes into the list. True when it did.
export async function enterUploads(taskId) {
  if (!(await uploadsReady())) return false;
  const { rowCount } = await pool.query(
    `update task set upload_from = now()
      where id = $1 and task_type = 'ad' and upload_from is null
        and exists (select 1 from task_content_format f where f.id = task.content_format_id and f.to_scheduling)`,
    [taskId],
  );
  return rowCount > 0;
}

// Reopened before any ad was recorded: out of the list; back in when it's
// approved again. Once an ad is recorded it stays — that ad is real.
export async function leaveUploads(taskId) {
  if (!(await uploadsReady())) return;
  await pool.query(
    `update task set upload_from = null
      where id = $1 and upload_from is not null and not exists (select 1 from task_ad a where a.task_id = task.id)`,
    [taskId],
  );
}

// A type's tick changed: ticked, this month's approved Ad work of it comes in;
// unticked, what's waiting with no ad recorded goes out.
export async function followAdTypeTick(orgId, formatId, on) {
  if (!(await uploadsReady())) return 0;
  const { rowCount } = on
    ? await pool.query(
      `update task set upload_from = completed_at
        where org_id = $1 and content_format_id = $2 and task_type = 'ad' and status = 'done'
          and upload_from is null and completed_at is not null
          and completed_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`,
      [orgId, formatId],
    )
    : await pool.query(
      `update task set upload_from = null
        where org_id = $1 and content_format_id = $2 and upload_from is not null
          and not exists (select 1 from task_ad a where a.task_id = task.id)`,
      [orgId, formatId],
    );
  return rowCount;
}
