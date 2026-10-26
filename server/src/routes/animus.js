import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { connectionOf } from "../connections.js";
import { NEEDS_UPLOADS_DB, recordAds, uploadsReady } from "../ad-uploads.js";

// Animus — the VSL team's ads register, its own app — talks to Echo server to
// server, connected to one brand by the line made in Settings › Connected apps
// (../connections.js). Its Builder picks an approved Ad task waiting in Ad
// uploads (the AID becomes the creative's number there), and once the ad is
// saved Animus sends back the AD numbers it became; they're recorded just as if
// typed in the task window, marked as sent by Animus. Every call carries the
// line's token in x-echo-token; a wrong or revoked one gets 401.
//   GET  /api/animus/hello       { app, label, brand: { id, name } } — checks a pasted line
//   GET  /api/animus/waiting     { ads: [...] } — the brand's approved Ad work in Ad uploads
//   POST /api/animus/recorded    { records: [{ taskId, adNumbers }] } → { results }
export const animusRouter = Router();

animusRouter.use(async (req, res, next) => {
  try {
    const c = await connectionOf(req.get("x-echo-token"));
    if (!c) return res.status(401).json({ error: "This connection line is wrong or was revoked. Make a new one in Echo › Settings › Connected apps." });
    if (!(await uploadsReady())) return res.status(409).json({ error: NEEDS_UPLOADS_DB });
    req.orgId = c.org_id;
    req.connection = c;
    next();
  } catch (err) { next(err); }
});

animusRouter.get("/hello", (req, res) => {
  const c = req.connection;
  res.json({ app: c.app, label: c.label, brand: { id: c.workspace_id, name: c.brand_name } });
});

// What the Builder offers: approved Ad work of the brand in Ad uploads — still
// waiting, or recorded in the last 60 days (picked again when it runs again).
animusRouter.get("/waiting", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select t.id as "taskId", t.ad_id as aid, t.title, e.name as "editorName", cf.name as "typeName",
              t.delivery_link as "videoLink", t.completed_at as "approvedAt",
              coalesce((select array_agg(a.ad_ref order by a.created_at, a.ad_ref) from task_ad a where a.task_id = t.id), '{}') as ads
         from task t left join editor e on e.id = t.editor_id left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and t.channel_id = $2 and t.task_type = 'ad' and t.status = 'done' and t.upload_from is not null
          and (not exists (select 1 from task_ad a where a.task_id = t.id) or t.upload_from > now() - interval '60 days')
        order by t.completed_at desc`,
      [req.orgId, req.connection.workspace_id],
    );
    res.json({ ads: rows });
  } catch (err) { next(err); }
});

const RecordedSchema = z.object({
  records: z.array(z.object({
    taskId: z.string().uuid(),
    adNumbers: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  })).min(1).max(200),
});

animusRouter.post("/recorded", async (req, res, next) => {
  const parsed = RecordedSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    const brandId = req.connection.workspace_id;
    const results = [];
    for (const r of parsed.data.records) {
      const { rows: [t] } = await pool.query(
        `select t.id, t.title, t.channel_id, t.status, t.task_type, t.upload_from, coalesce(t.ad_id, t.sid, t.tid) as ref
           from task t where t.id = $1 and t.org_id = $2 and t.channel_id = $3`,
        [r.taskId, req.orgId, brandId],
      );
      if (!t) { results.push({ taskId: r.taskId, added: [], already: [], clash: [], error: "No such Ad task for this brand." }); continue; }
      if (t.task_type !== "ad" || t.status !== "done" || !t.upload_from) {
        results.push({ taskId: r.taskId, added: [], already: [], clash: [], error: `${t.ref} isn't waiting in Ad uploads.` });
        continue;
      }
      results.push({ taskId: r.taskId, ...(await recordAds({ orgId: req.orgId, task: t, refs: r.adNumbers, source: "animus" })) });
    }
    res.json({ results });
  } catch (err) { next(err); }
});
