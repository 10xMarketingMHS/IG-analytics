import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { connectionOf } from "../connections.js";
import { attemptLimiter } from "../attempts.js";
import { NEEDS_UPLOADS_DB, adRefOf, recordAds, uploadsReady } from "../ad-uploads.js";
import { NEEDS_RESULTS_DB, resultsReady } from "../ad-results.js";
import { validYmd } from "../leave-math.js";

// Animus — the VSL team's ads register, its own app — talks to Echo server to
// server, connected to one Ads team (VSL) by the line made in Settings › Connected apps
// (../connections.js). Its Builder picks an approved Ad task waiting in Ad
// uploads (the AID becomes the creative's number there), and once the ad is
// saved Animus sends back the AD numbers it became; they're recorded just as if
// typed in the task window, marked as sent by Animus. Every call carries the
// line's token in x-echo-token; a wrong or revoked one gets 401.
//   GET  /api/animus/hello       { app, label, brand: { id, name } } — checks a pasted line ("brand": the team)
//   GET  /api/animus/waiting     { ads: [...] } — the team's approved Ad work in Ad uploads
//   POST /api/animus/recorded    { records: [{ taskId, adNumbers }] } → { results }
//   POST /api/animus/results     { asOf, ads: [{ adNumber, status, liveFrom, spend, … }] } → { matched, unknown }
export const animusRouter = Router();

// Wrong lines: 10 for one connection from one address, or 60 from one address,
// in 15 minutes, then a wait — so a flood of made-up lines can't keep Echo's
// few database connections busy, and one revoked line doesn't stop the others.
const wrongLines = attemptLimiter({ windowMs: 15 * 60_000, perEmail: 10, perAddress: 60 });

animusRouter.use(async (req, res, next) => {
  try {
    const token = req.get("x-echo-token");
    const ip = req.ip || req.socket?.remoteAddress || "?";
    const id = String(token ?? "").split(".")[1]?.slice(0, 36) ?? "";
    const wait = wrongLines.wait(ip, id);
    if (wait) return res.status(429).json({ error: `Too many wrong connection lines. Try again in ${wait} minute${wait === 1 ? "" : "s"}.` });
    const c = await connectionOf(token);
    if (!c) {
      wrongLines.count(ip, id);
      return res.status(401).json({ error: "This connection line is wrong or was revoked. Make a new one in Echo › Settings › Connected apps." });
    }
    if (!(await uploadsReady())) return res.status(409).json({ error: NEEDS_UPLOADS_DB });
    req.orgId = c.org_id;
    req.connection = c;
    next();
  } catch (err) { next(err); }
});

animusRouter.get("/hello", (req, res) => {
  const c = req.connection;
  // "brand" is the team, under the name Animus already reads
  res.json({ app: c.app, label: c.label, brand: { id: c.ad_team_id ?? c.workspace_id, name: c.team_name } });
});

// What the Builder offers: approved Ad work of the team in Ad uploads — still
// waiting, or recorded in the last 60 days (picked again when it runs again).
animusRouter.get("/waiting", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select t.id as "taskId", t.ad_id as aid, t.title, e.name as "editorName", cf.name as "typeName",
              t.delivery_link as "videoLink", t.completed_at as "approvedAt",
              coalesce((select array_agg(a.ad_ref order by a.created_at, a.ad_ref) from task_ad a where a.task_id = t.id), '{}') as ads
         from task t left join editor e on e.id = t.editor_id left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and coalesce(t.ad_team_id, t.channel_id) = $2 and t.task_type = 'ad' and t.status = 'done' and t.upload_from is not null
          and (not exists (select 1 from task_ad a where a.task_id = t.id) or t.upload_from > now() - interval '60 days')
        order by t.completed_at desc`,
      [req.orgId, req.connection.ad_team_id ?? req.connection.workspace_id],
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
    const scope = req.connection.ad_team_id ?? req.connection.workspace_id;
    const results = [];
    for (const r of parsed.data.records) {
      const { rows: [t] } = await pool.query(
        `select t.id, t.title, t.channel_id, t.ad_team_id, t.status, t.task_type, t.upload_from, coalesce(t.ad_id, t.sid, t.tid) as ref
           from task t where t.id = $1 and t.org_id = $2 and coalesce(t.ad_team_id, t.channel_id) = $3`,
        [r.taskId, req.orgId, scope],
      );
      if (!t) { results.push({ taskId: r.taskId, added: [], already: [], clash: [], error: "No such Ad task for this team." }); continue; }
      if (t.task_type !== "ad" || t.status !== "done" || !t.upload_from) {
        results.push({ taskId: r.taskId, added: [], already: [], clash: [], error: `${t.ref} isn't waiting in Ad uploads.` });
        continue;
      }
      results.push({ taskId: r.taskId, ...(await recordAds({ orgId: req.orgId, task: t, refs: r.adNumbers, source: "animus" })) });
    }
    res.json({ results });
  } catch (err) { next(err); }
});

// Each ad's results, sent by Animus after every spend sync (Ads performance,
// ../ad-results.js). Animus sends all its funnel's ads; Echo keeps the ones it
// has recorded for this line's team and ignores the rest. The latest call
// replaces each ad's numbers; its typed notes are left alone.
const num = z.number().finite().nullable().optional();
const ResultsSchema = z.object({
  asOf: z.string().max(40).optional(),
  ads: z.array(z.object({
    adNumber: z.string().trim().min(1).max(120),
    status: z.string().trim().max(20).nullable().optional(),
    liveFrom: z.string().refine(validYmd).nullable().optional(),
    spend: num, impressions: num, hookRate: num, holdRate: num, optIns: num, leads: num,
    conversions: num, revenue: num, roas: num, score: num,
  })).max(1000),
});

animusRouter.post("/results", async (req, res, next) => {
  const parsed = ResultsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await resultsReady())) return res.status(409).json({ error: NEEDS_RESULTS_DB });
    const scope = req.connection.ad_team_id ?? req.connection.workspace_id;
    const int = (v) => (v == null ? null : Math.round(v));
    const ads = parsed.data.ads.map((a) => ({
      ref: adRefOf(a.adNumber), ad_status: a.status ?? null, published_on: a.liveFrom ?? null,
      spend: a.spend ?? null, impressions: int(a.impressions), hook_rate: a.hookRate ?? null, hold_rate: a.holdRate ?? null,
      opt_ins: int(a.optIns), leads: int(a.leads), conversions: int(a.conversions), revenue: a.revenue ?? null,
      roas: a.roas ?? null, score: int(a.score),
    }));
    const { rows } = ads.length ? await pool.query(
      `with x as (
         select * from jsonb_to_recordset($2::jsonb) as r(ref text, ad_status text, published_on date, spend numeric, impressions bigint,
           hook_rate numeric, hold_rate numeric, opt_ins int, leads int, conversions int, revenue numeric, roas numeric, score int))
       update task_ad a set ad_status = x.ad_status, published_on = coalesce(x.published_on, a.published_on), spend = x.spend,
              impressions = x.impressions, hook_rate = x.hook_rate, hold_rate = x.hold_rate, opt_ins = x.opt_ins, leads = x.leads,
              conversions = x.conversions, revenue = x.revenue, roas = x.roas, score = x.score,
              results_source = 'animus', results_at = now(), results_by = null
         from x where coalesce(a.ad_team_id, a.workspace_id) = $1 and lower(a.ad_ref) = lower(x.ref)
       returning lower(a.ad_ref) as ref`,
      [scope, JSON.stringify(ads)],
    ) : { rows: [] };
    const matched = new Set(rows.map((r) => r.ref));
    res.json({ matched: matched.size, unknown: new Set(ads.map((a) => a.ref.toLowerCase())).size - matched.size });
  } catch (err) { next(err); }
});
