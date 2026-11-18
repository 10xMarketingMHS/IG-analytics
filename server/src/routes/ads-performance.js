import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePage } from "../page-access.js";
import { validYmd } from "../leave-math.js";
import { uploadsReady } from "../ad-uploads.js";
import { NEEDS_RESULTS_DB, combine, resultsOf, resultsReady, summarize, windowWords } from "../ad-results.js";

// Ads performance (../ad-results.js) — everyone's view of the ads, like the
// team's "Ads Tracker" sheet: every Ad task set in a date range (the sheet's
// Date), with its results; the editors and teams added up from them.
//   GET /ads-performance?from=YYYY-MM-DD&to=YYYY-MM-DD&team=<id>
//     → { from, to, today, teams: [...], ads: [...], editors: [...], byTeam: [...] }
export const adsPerformanceRouter = Router();

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const Query = z.object({
  from: z.string().refine(validYmd).optional(),
  to: z.string().refine(validYmd).optional(),
  team: z.string().uuid().optional(),
});

adsPerformanceRouter.get("/ads-performance", requirePage("adsPerformance"), async (req, res, next) => {
  const parsed = Query.safeParse(req.query ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick a valid date range." });
  try {
    if (!(await uploadsReady()) || !(await resultsReady())) return res.status(409).json({ error: NEEDS_RESULTS_DB });
    const { from, to, team } = parsed.data;
    const today = todayIst();
    // Ad tasks set in the range (the date they were set, IST), any stage
    const { rows: tasks } = await pool.query(
      `select t.id, coalesce(t.ad_id, t.tid) as aid, t.title, t.status, t.delivery_link as "videoLink",
              (t.created_at at time zone 'Asia/Kolkata')::date::text as "setOn", t.completed_at as "approvedAt",
              t.editor_id as "editorId", e.name as "editorName",
              coalesce(t.ad_team_id, t.channel_id) as "teamId", coalesce(tm.name, w.name) as "teamName",
              cf.name as "typeName"
         from task t
         left join editor e on e.id = t.editor_id
         left join ad_team tm on tm.id = t.ad_team_id
         left join workspace w on w.id = t.channel_id
         left join task_content_format cf on cf.id = t.content_format_id
        where t.org_id = $1 and t.task_type = 'ad'
          and ($2::date is null or (t.created_at at time zone 'Asia/Kolkata')::date >= $2::date)
          and ($3::date is null or (t.created_at at time zone 'Asia/Kolkata')::date <= $3::date)
          and ($4::uuid is null or coalesce(t.ad_team_id, t.channel_id) = $4::uuid)
        order by t.created_at desc`,
      [req.orgId, from ?? null, to ?? null, team ?? null],
    );
    const { rows: ads } = tasks.length
      ? await pool.query("select * from task_ad where task_id = any($1::uuid[]) order by created_at, ad_ref", [tasks.map((t) => t.id)])
      : { rows: [] };
    const byTask = new Map();
    for (const a of ads) byTask.set(a.task_id, [...(byTask.get(a.task_id) ?? []), { id: a.id, ref: a.ad_ref, ...resultsOf(a) }]);
    const rows = tasks.map((t) => {
      const list = byTask.get(t.id) ?? [];
      // the sheet's Status: Pending (still being made), Done (approved, not up yet), Published (its ads are recorded)
      const stage = t.status !== "done" ? "pending" : list.length ? "published" : "done";
      const results = combine(list);
      return {
        ...t, stage, adRefs: list.map((a) => a.ref), ads: list, results,
        window: stage === "published" ? windowWords(results?.publishedOn ?? null, today) : null,
      };
    });
    const { rows: teams } = await pool.query(
      `select tm.id, tm.name from ad_team tm where tm.org_id = $1 and tm.active order by tm.sort_order, lower(tm.name)`, [req.orgId],
    );
    res.json({
      from: from ?? null, to: to ?? null, today, teams, ads: rows,
      editors: summarize(rows, (t) => t.editorId ?? "none", (t) => t.editorName ?? "No editor"),
      byTeam: summarize(rows, (t) => t.teamId ?? "none", (t) => t.teamName ?? "No team"),
    });
  } catch (err) { next(err); }
});
