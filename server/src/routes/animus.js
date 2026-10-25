import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { config } from "../config.js";
import { NEEDS_UPLOADS_DB, recordAds, uploadsReady } from "../ad-uploads.js";

// Animus — the VSL team's ads register, its own app — talks to Echo server to
// server. Its Builder picks an approved Ad task waiting in Ad uploads (the AID
// becomes the creative's number there), and once the ad is saved Animus sends
// back the AD numbers it became; they're recorded just as if typed in the task
// window, marked as sent by Animus. Every call carries x-animus-key, the shared
// ANIMUS_KEY; without one set, these endpoints don't exist (404).
//   GET  /api/animus/brands              { brands: [{ id, name }] } — a funnel is linked to one
//   GET  /api/animus/waiting?brand=      { ads: [...] } — the brand's approved Ad work in Ad uploads
//   POST /api/animus/recorded            { brand, records: [{ taskId, adNumbers }] } → { results }
export const animusRouter = Router();

// compared as hashes, so the length of a wrong key gives nothing away
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
animusRouter.use(async (req, res, next) => {
  if (!config.ANIMUS_KEY) return res.status(404).json({ error: "Not found" });
  const sent = req.get("x-animus-key");
  if (!sent || !crypto.timingSafeEqual(digest(sent), digest(config.ANIMUS_KEY))) return res.status(401).json({ error: "Wrong or missing key." });
  try {
    if (!(await uploadsReady())) return res.status(409).json({ error: NEEDS_UPLOADS_DB });
    // the one organisation, or the one named
    const { rows } = config.ANIMUS_ORG_ID
      ? await pool.query("select id from org where id = $1", [config.ANIMUS_ORG_ID])
      : await pool.query("select id from org limit 2");
    if (rows.length !== 1) return res.status(503).json({ error: "Set ANIMUS_ORG_ID: Echo has more than one organisation." });
    req.orgId = rows[0].id;
    next();
  } catch (err) { next(err); }
});

const brandOf = async (orgId, id) =>
  z.string().uuid().safeParse(id).success
    ? (await pool.query("select id, name from workspace where id = $1 and org_id = $2", [id, orgId])).rows[0] ?? null
    : null;

animusRouter.get("/brands", async (req, res, next) => {
  try {
    const { rows } = await pool.query("select id, name from workspace where org_id = $1 order by name", [req.orgId]);
    res.json({ brands: rows });
  } catch (err) { next(err); }
});

// What the Builder offers: approved Ad work of the brand in Ad uploads — still
// waiting, or recorded in the last 60 days (picked again when it runs again).
animusRouter.get("/waiting", async (req, res, next) => {
  try {
    const brand = await brandOf(req.orgId, req.query.brand);
    if (!brand) return res.status(404).json({ error: "No such brand." });
    const { rows } = await pool.query(
      `select t.id as "taskId", t.ad_id as aid, t.title, e.name as "editorName", cf.name as "typeName",
              t.delivery_link as "videoLink", t.completed_at as "approvedAt",
              coalesce((select array_agg(a.ad_ref order by a.created_at, a.ad_ref) from task_ad a where a.task_id = t.id), '{}') as ads
         from task t left join editor e on e.id = t.editor_id left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and t.channel_id = $2 and t.task_type = 'ad' and t.status = 'done' and t.upload_from is not null
          and (not exists (select 1 from task_ad a where a.task_id = t.id) or t.upload_from > now() - interval '60 days')
        order by t.completed_at desc`,
      [req.orgId, brand.id],
    );
    res.json({ ads: rows });
  } catch (err) { next(err); }
});

const RecordedSchema = z.object({
  brand: z.string().uuid(),
  records: z.array(z.object({
    taskId: z.string().uuid(),
    adNumbers: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  })).min(1).max(200),
});

animusRouter.post("/recorded", async (req, res, next) => {
  const parsed = RecordedSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    const brand = await brandOf(req.orgId, parsed.data.brand);
    if (!brand) return res.status(404).json({ error: "No such brand." });
    const results = [];
    for (const r of parsed.data.records) {
      const { rows: [t] } = await pool.query(
        `select t.id, t.title, t.channel_id, t.status, t.task_type, t.upload_from, coalesce(t.ad_id, t.sid, t.tid) as ref
           from task t where t.id = $1 and t.org_id = $2 and t.channel_id = $3`,
        [r.taskId, req.orgId, brand.id],
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
