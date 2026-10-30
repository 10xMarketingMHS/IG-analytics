import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission } from "../permissions.js";
import { hasColumn } from "../schema-flags.js";
import { logActivity } from "../activity.js";
import { headingError, headingTypes, notHeadingSql } from "../type-tree.js";

// Goals › Brand goals: how many jobs of each task type a brand needs in a month
// (Doctor Farmer 30 Reels, My Health School 30 Reels), and for Ads each Ads team
// (Ad tasks are made for a team). Beside them, what's been done there this month,
// and how much of each type the team's goals give out (Set goals shows the same:
// "Brands need 60 · 45 given · 15 to give"). They don't change anyone's score.
// Admins and the goal editors (edit_goals), like Set goals.
//   GET  /brand-goals?month=YYYY-MM-01
//   PUT  /brand-goals        { month, goals: [{ contentFormatId, channelId | adTeamId, jobs | null }] }
//   POST /brand-goals/copy   { month }  — last month's into this one, where this one has none yet
// 20261111120000_brand_goal
export const brandGoalsRouter = Router();

const NEEDS_DB = "Brand goals need a database update first — ask whoever runs the database to apply 20261111120000_brand_goal.";
export const brandGoalsReady = () => hasColumn("brand_goal", "jobs");

// "2026-10" or "2026-10-14" → "2026-10-01"
function monthStart(v) {
  const m = /^(\d{4})-(\d{2})/.exec(String(v ?? ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}
const prevMonth = (first) => {
  const [y, m] = first.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
};
const IST_MONTH = (col) => `${col} >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
  and ${col} < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`;
// the types tracked in goals (Settings › Tasks & time › Goal)
const GOAL_TYPE = "active and category in ('social', 'ad', 'service', 'project') and coalesce((to_jsonb(task_content_format)->>'counts_in_goal')::boolean, true)";

// Each brand's goals per type: { [contentFormatId]: jobs } summed (for Set goals)
export async function brandNeedByType(orgId, month) {
  if (!(await brandGoalsReady())) return {};
  const { rows } = await pool.query(
    "select content_format_id as id, sum(jobs)::int as n from brand_goal where org_id = $1 and period_month = $2 group by content_format_id",
    [orgId, month],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

brandGoalsRouter.get("/brand-goals", requirePermission("edit_goals"), async (req, res, next) => {
  const month = monthStart(req.query.month);
  if (!month) return res.status(400).json({ error: "That month couldn't be read." });
  try {
    if (!(await brandGoalsReady())) return res.json({ ready: false, month, error: NEEDS_DB });
    const teamsOn = await hasColumn("ad_team", "active");
    const [types, brands, teams, goals, done, given] = await Promise.all([
      pool.query(`select id, name, icon, category from task_content_format where org_id = $1 and ${GOAL_TYPE} order by category, sort_order, name`, [req.orgId]),
      pool.query("select id, name from workspace where org_id = $1 order by created_at", [req.orgId]),
      teamsOn ? pool.query("select id, name, lead_name as \"leadName\" from ad_team where org_id = $1 and active order by sort_order, name", [req.orgId]) : { rows: [] },
      pool.query(
        `select content_format_id as "contentFormatId", channel_id as "channelId", ad_team_id as "adTeamId", jobs
           from brand_goal where org_id = $1 and period_month = $2`,
        [req.orgId, month],
      ),
      // done this month (India time): Ads by their team, everything else by its brand
      pool.query(
        `select t.content_format_id as "contentFormatId",
                case when t.task_type = 'ad' then null else t.channel_id end as "channelId",
                case when t.task_type = 'ad' then (to_jsonb(t)->>'ad_team_id')::uuid end as "adTeamId",
                count(*)::int as n
           from task t
          where t.org_id = $1 and t.status = 'done' and t.content_format_id is not null and ${IST_MONTH("t.completed_at")}
          group by 1, 2, 3`,
        [req.orgId, month],
      ),
      // what the team's goals give out, per type (Set goals) — not counting anyone
      // exempt from task scoring (Team › Roster › Task score), who isn't given goals
      pool.query(
        `select g.content_format_id as id, sum(g.jc)::int as n
           from editor_goal g join editor e on e.id = g.editor_id
          where g.org_id = $1 and g.period_month = $2 and g.jc > 0 and e.active
            and coalesce((to_jsonb(e)->>'in_task_score')::boolean, true)
          group by g.content_format_id`,
        [req.orgId, month],
      ),
    ]);
    res.json({
      ready: true, month, prevMonth: prevMonth(month),
      types: types.rows, brands: brands.rows, teams: teams.rows,
      goals: goals.rows,
      done: done.rows.filter((d) => d.channelId || d.adTeamId),
      given: Object.fromEntries(given.rows.map((g) => [g.id, g.n])),
    });
  } catch (err) {
    next(err);
  }
});

const SaveSchema = z.object({
  month: z.string(),
  goals: z.array(z.object({
    contentFormatId: z.string().uuid(),
    channelId: z.string().uuid().nullable().optional(),
    adTeamId: z.string().uuid().nullable().optional(),
    jobs: z.number().int().min(0).max(100000).nullable(),
  })).max(2000),
});

brandGoalsRouter.put("/brand-goals", requirePermission("edit_goals"), async (req, res, next) => {
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Each brand goal is a whole number of jobs." });
  const month = monthStart(parsed.data.month);
  if (!month) return res.status(400).json({ error: "That month couldn't be read." });
  const cells = parsed.data.goals;
  const client = await pool.connect();
  try {
    if (!(await brandGoalsReady())) return res.status(409).json({ error: NEEDS_DB });
    // every type, brand and team must be this organisation's; Ads go on a team, the rest on a brand
    const typeIds = [...new Set(cells.map((c) => c.contentFormatId))];
    const [types, brands, teams] = await Promise.all([
      pool.query(`select id, category from task_content_format where org_id = $1 and id = any($2::uuid[]) and ${GOAL_TYPE}`, [req.orgId, typeIds]),
      pool.query("select id from workspace where org_id = $1", [req.orgId]),
      (await hasColumn("ad_team", "active")) ? pool.query("select id from ad_team where org_id = $1", [req.orgId]) : { rows: [] },
    ]);
    const kind = new Map(types.rows.map((t) => [t.id, t.category]));
    const brandIds = new Set(brands.rows.map((b) => b.id)), teamIds = new Set(teams.rows.map((t) => t.id));
    for (const c of cells) {
      const cat = kind.get(c.contentFormatId);
      if (!cat) return res.status(400).json({ error: "That task type isn't one tracked in goals." });
      if (cat === "ad" ? !(c.adTeamId && teamIds.has(c.adTeamId) && !c.channelId) : !(c.channelId && brandIds.has(c.channelId) && !c.adTeamId)) {
        return res.status(400).json({ error: cat === "ad" ? "Ads goals go on an Ads team." : "That goal needs one of your brands." });
      }
    }
    // a heading takes no new goal (../type-tree.js)
    const headings = await headingTypes(req.orgId, typeIds);
    if (headings.size) {
      const { rows: had } = await pool.query(
        "select content_format_id, coalesce(channel_id, ad_team_id) as place, jobs from brand_goal where org_id = $1 and period_month = $2 and content_format_id = any($3::uuid[])",
        [req.orgId, month, [...headings.keys()]],
      );
      const was = new Map(had.map((r) => [`${r.content_format_id}:${r.place}`, r.jobs]));
      const up = cells.find((c) => c.jobs != null && headings.has(c.contentFormatId) && c.jobs > (was.get(`${c.contentFormatId}:${c.adTeamId ?? c.channelId}`) ?? -1));
      if (up) return res.status(400).json({ error: headingError(headings.get(up.contentFormatId)) });
    }
    await client.query("begin");
    let saved = 0;
    for (const c of cells) {
      const where = c.adTeamId ? "ad_team_id = $4" : "channel_id = $4";
      if (c.jobs == null) {
        await client.query(
          `delete from brand_goal where org_id = $1 and period_month = $2 and content_format_id = $3 and ${where}`,
          [req.orgId, month, c.contentFormatId, c.adTeamId ?? c.channelId],
        );
      } else {
        await client.query(
          `insert into brand_goal (org_id, period_month, content_format_id, channel_id, ad_team_id, jobs, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (org_id, period_month, content_format_id, (coalesce(channel_id, ad_team_id)))
           do update set jobs = excluded.jobs, updated_by = excluded.updated_by, updated_at = now()`,
          [req.orgId, month, c.contentFormatId, c.adTeamId ? null : c.channelId, c.adTeamId ?? null, c.jobs, req.user.sub],
        );
      }
      saved++;
    }
    await client.query("commit");
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "brand_goals_saved", entityType: "brand_goal",
      summary: `Saved brand goals for ${month.slice(0, 7)}`, meta: { month, cells: saved },
    });
    res.json({ ok: true, saved });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

brandGoalsRouter.post("/brand-goals/copy", requirePermission("edit_goals"), async (req, res, next) => {
  const month = monthStart(req.body?.month);
  if (!month) return res.status(400).json({ error: "That month couldn't be read." });
  try {
    if (!(await brandGoalsReady())) return res.status(409).json({ error: NEEDS_DB });
    // last month's goals, for the types still tracked (and not only a heading now) and the teams still active; this month's own stay
    const notHeading = await notHeadingSql("f");
    const { rowCount } = await pool.query(
      `insert into brand_goal (org_id, period_month, content_format_id, channel_id, ad_team_id, jobs, updated_by)
       select b.org_id, $2::date, b.content_format_id, b.channel_id, b.ad_team_id, b.jobs, $4
         from brand_goal b join task_content_format f on f.id = b.content_format_id
        where b.org_id = $1 and b.period_month = $3::date
          and f.active and f.category in ('social', 'ad', 'service', 'project') and coalesce((to_jsonb(f)->>'counts_in_goal')::boolean, true)${notHeading}
          and (b.ad_team_id is null or exists (select 1 from ad_team a where a.id = b.ad_team_id and a.active))
       on conflict (org_id, period_month, content_format_id, (coalesce(channel_id, ad_team_id))) do nothing`,
      [req.orgId, month, prevMonth(month), req.user.sub],
    );
    res.json({ ok: true, copied: rowCount });
  } catch (err) {
    next(err);
  }
});
