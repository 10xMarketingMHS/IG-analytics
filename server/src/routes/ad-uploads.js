import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { requireActiveEod } from "./eod.js";
import { mayOpenTask, taskViewer } from "../hierarchy.js";
import { logActivity } from "../activity.js";
import { taskSelect } from "./tasks.js";
import { NEEDS_UPLOADS_DB, recordAds, uploadStage, uploadsReady } from "../ad-uploads.js";

// Ad uploads (../ad-uploads.js): approved Ad work waits here for the Managers
// and Team Leads — the leads by position (Team › Roster), and the Super Admin —
// who record which ads each piece became. Nobody else sees it.
//   GET    /ad-uploads/access       may the caller see it, and how many wait
//   GET    /ad-uploads              the list: waiting, and what was recorded in the last 60 days
//   GET    /tasks/:id/ads           one task's ads, and whether the caller may record them
//   POST   /tasks/:id/ads           { refs: ["AD205", "AD206"] } — or another team's ad names
//   DELETE /tasks/:id/ads/:adId     a mistyped one out again
export const adUploadsRouter = Router();

const REF = "coalesce(t.ad_id, t.sid, t.tid)";
const NOT_LEAD = "Ad uploads is for the Managers and Team Leads.";
const isLead = async (req) => { const v = await taskViewer(req); return v.seesAll || v.rank <= 2; };

async function taskRow(orgId, taskId) {
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.task_type, t.channel_id, t.ad_team_id, t.upload_from, ${REF} as ref
       from task t where t.id = $1 and t.org_id = $2`,
    [taskId, orgId],
  );
  return rows[0] ?? null;
}
async function adsOf(taskId) {
  const { rows } = await pool.query(
    `select a.id, a.ad_ref as "ref", a.source, a.created_at as "createdAt", coalesce(e.name, u.email) as "byName"
       from task_ad a left join app_user u on u.id = a.created_by left join editor e on e.id = u.editor_id
      where a.task_id = $1 order by a.created_at, a.ad_ref`,
    [taskId],
  );
  return rows;
}
async function view(t, lead) {
  const ads = await adsOf(t.id);
  return {
    ready: true, inFlow: !!t.upload_from,
    stage: uploadStage({ ...t, ad_count: ads.length }),
    ads, canRecord: lead && !!t.upload_from && t.status === "done",
  };
}

adUploadsRouter.get("/ad-uploads/access", async (req, res, next) => {
  try {
    if (!(await uploadsReady()) || !(await isLead(req))) return res.json({ allowed: false, waiting: 0 });
    const { rows: [n] } = await pool.query(
      `select count(*)::int as n from task t
        where t.org_id = $1 and t.status = 'done' and t.upload_from is not null
          and not exists (select 1 from task_ad a where a.task_id = t.id)`,
      [req.orgId],
    );
    res.json({ allowed: true, waiting: n.n });
  } catch (err) { next(err); }
});

adUploadsRouter.get("/ad-uploads", async (req, res, next) => {
  try {
    if (!(await uploadsReady())) return res.status(409).json({ error: NEEDS_UPLOADS_DB });
    if (!(await isLead(req))) return res.status(403).json({ error: NOT_LEAD });
    const { rows } = await pool.query(
      `${await taskSelect()}
        where t.org_id = $1 and t.status = 'done' and (to_jsonb(t)->>'upload_from') is not null
          and (not exists (select 1 from task_ad a where a.task_id = t.id)
               or (to_jsonb(t)->>'upload_from')::timestamptz > now() - interval '60 days')
        order by (to_jsonb(t)->>'upload_from')::timestamptz`,
      [req.orgId],
    );
    // each task's ads, by name, beside it
    const { rows: ads } = rows.length
      ? await pool.query("select task_id, ad_ref from task_ad where task_id = any($1::uuid[]) order by created_at, ad_ref", [rows.map((r) => r.id)])
      : { rows: [] };
    const byTask = new Map();
    for (const a of ads) byTask.set(a.task_id, [...(byTask.get(a.task_id) ?? []), a.ad_ref]);
    res.json({ tasks: rows.map((r) => ({ ...r, ad_refs: byTask.get(r.id) ?? [] })) });
  } catch (err) { next(err); }
});

adUploadsRouter.get("/tasks/:id/ads", async (req, res, next) => {
  try {
    if (!(await uploadsReady())) return res.json({ ready: false });
    const lead = await isLead(req);
    const t = await taskRow(req.orgId, req.params.id);
    // the task window shows it to whoever may open the task; only the leads record
    if (!t || (!lead && !(await mayOpenTask(req, t.id)))) return res.status(404).json({ error: "Task not found." });
    res.json(await view(t, lead));
  } catch (err) { next(err); }
});

const AdsSchema = z.object({
  refs: z.array(z.string().trim().min(1, "Type the ad's number or name.").max(120, "That's too long for an ad's name."))
    .min(1, "Type at least one ad.").max(20),
});

adUploadsRouter.post("/tasks/:id/ads", requireEditor, requireActiveEod, async (req, res, next) => {
  const parsed = AdsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await uploadsReady())) return res.status(409).json({ error: NEEDS_UPLOADS_DB });
    if (!(await isLead(req))) return res.status(403).json({ error: NOT_LEAD });
    const t = await taskRow(req.orgId, req.params.id);
    if (!t) return res.status(404).json({ error: "Task not found." });
    if (!t.upload_from || t.status !== "done" || !(t.ad_team_id || t.channel_id)) return res.status(409).json({ error: "This task isn't waiting for its ads." });
    // an ad belongs to one piece of work: with one already on another, record none and say which
    const r = await recordAds({ orgId: req.orgId, task: t, refs: parsed.data.refs, source: "manual", userId: req.user.sub, allOrNothing: true });
    if (r.clash.length) return res.status(409).json({ error: `${r.clash[0].ad} is already recorded on ${r.clash[0].on}.` });
    res.status(r.added.length ? 201 : 200).json(await view(t, true));
  } catch (err) { next(err); }
});

adUploadsRouter.delete("/tasks/:id/ads/:adId", requireEditor, requireActiveEod, async (req, res, next) => {
  try {
    if (!(await uploadsReady())) return res.status(409).json({ error: NEEDS_UPLOADS_DB });
    if (!(await isLead(req))) return res.status(403).json({ error: NOT_LEAD });
    const t = await taskRow(req.orgId, req.params.id);
    if (!t) return res.status(404).json({ error: "Task not found." });
    const { rows } = await pool.query("delete from task_ad where id = $1 and task_id = $2 returning ad_ref", [req.params.adId, t.id]);
    if (!rows.length) return res.status(404).json({ error: "That ad isn't on this task." });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "ad_unrecorded", entityType: "task", entityId: t.id, channelId: t.channel_id,
      summary: `Took ${rows[0].ad_ref} off ${t.ref} “${t.title}”`,
      meta: { ads: [rows[0].ad_ref] },
    });
    res.json(await view(t, true));
  } catch (err) { next(err); }
});
