import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { logActivity } from "./activity.js";

// Ad uploads (20261106120000_ad_uploads): an approved Ad task whose type is
// ticked to go on after approval (Settings › Tasks & time) waits in one list
// for the Managers and Team Leads. They record which ads it became — the AD
// number Animus gave it for the VSL team, or the ad's name or number the other
// teams send back — one task, one or more ads (task_ad). Record-keeping only:
// no job credit. Ads are made for Ads teams (VSL, Longer Life, Webinar), so an
// ad's name is unique within its team — or its brand, for an Ad task made
// before teams.

export const adTeamsReady = () => hasColumn("task", "ad_team_id");
export const uploadsReady = async () => (await hasColumn("task", "upload_from")) && (await hasColumn("task_ad", "ad_team_id"))
  && hasColumn("task_content_format", "to_scheduling");

// The team's next AID: AID-00001, AID-00002… counted per team.
export async function nextTeamAid(teamId, db = pool) {
  const { rows } = await db.query("update ad_team set next_aid = next_aid + 1 where id = $1 returning next_aid", [teamId]);
  if (!rows.length) throw new Error("No such Ads team.");
  return `AID-${String(rows[0].next_aid).padStart(5, "0")}`;
}
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

// Records ads on an approved Ad task in the list — typed in the task window
// (source "manual") or sent by Animus ("animus", routes/animus.js). Tidied, one
// of each. An ad already on this task is "already"; one on another task of the
// brand is a clash and isn't recorded (allOrNothing: then none are). task: id,
// title, ad_team_id, channel_id, ref.
export async function recordAds({ orgId, task, refs, source = "manual", userId = null, allOrNothing = false }) {
  const tidy = [...new Map(refs.map(adRefOf).filter(Boolean).map((r) => [r.toLowerCase(), r])).values()];
  // an ad's name is unique within the task's team (or its brand, before teams)
  const scope = task.ad_team_id ?? task.channel_id;
  const { rows: taken } = await pool.query(
    `select a.ad_ref, a.task_id, coalesce(t.ad_id, t.sid, t.tid) as ref, t.title from task_ad a join task t on t.id = a.task_id
      where coalesce(a.ad_team_id, a.workspace_id) = $1 and lower(a.ad_ref) = any($2::text[])`,
    [scope, tidy.map((r) => r.toLowerCase())],
  );
  // answered in the order they were sent
  const byName = new Map(taken.map((x) => [x.ad_ref.toLowerCase(), x]));
  const seen = tidy.map((r) => byName.get(r.toLowerCase())).filter(Boolean);
  const already = seen.filter((x) => x.task_id === task.id).map((x) => x.ad_ref);
  const clash = seen.filter((x) => x.task_id !== task.id).map((x) => ({ ad: x.ad_ref, on: `${x.ref} “${x.title}”` }));
  const known = new Set(byName.keys());
  const fresh = allOrNothing && clash.length ? [] : tidy.filter((r) => !known.has(r.toLowerCase()));
  // two at once: whichever lands second records nothing (the unique name per brand)
  const added = fresh.length ? (await pool.query(
    `insert into task_ad (org_id, workspace_id, ad_team_id, task_id, ad_ref, source, created_by)
     select $1, $2, $7, $3, r, $5, $6 from unnest($4::text[]) as r
     on conflict (coalesce(ad_team_id, workspace_id), lower(ad_ref)) do nothing returning ad_ref`,
    [orgId, task.channel_id ?? null, task.id, fresh, source, userId, task.ad_team_id ?? null],
  )).rows.map((x) => x.ad_ref) : [];
  if (added.length) {
    await logActivity({
      orgId, actorId: userId, verb: "ad_recorded", entityType: "task", entityId: task.id, channelId: task.channel_id,
      summary: `${source === "animus" ? "Animus recorded" : "Recorded"} ${added.join(", ")} for ${task.ref} “${task.title}”`,
      meta: { ads: added, source },
    });
  }
  return { added, already, clash };
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
