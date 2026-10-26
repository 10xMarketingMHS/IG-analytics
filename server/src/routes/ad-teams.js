import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission } from "../permissions.js";
import { adTeamsReady } from "../ad-uploads.js";

// Ads teams (Settings › Tasks & time): the teams ads are made for — VSL,
// Longer Life, Webinar — each with its lead. An Ad task picks its team and is
// numbered within it (AID-00001…); its task type stays shared, so goals don't
// split by team. Everyone signed in reads the list (the task form needs it);
// admins and the task_settings grant change it. Removing one keeps its tasks.
//   GET    /ad-teams          { teams: [{ id, name, leadName, active, tasks }] }
//   POST   /ad-teams          { name, leadName }
//   PATCH  /ad-teams/:id      { name?, leadName? }
//   DELETE /ad-teams/:id      no longer offered for new tasks
export const adTeamsRouter = Router();

const NEEDS_DB = "Ads teams needs a database update first — ask whoever runs the database to apply 20261106120000_ad_uploads.";
const SELECT = `select tm.id, tm.name, tm.lead_name as "leadName", tm.active,
                       (select count(*)::int from task t where t.ad_team_id = tm.id) as tasks
                  from ad_team tm`;
const name = z.string().trim().min(1, "Give the team a name.").max(40, "Keep the name under 40 characters.");
const leadName = z.string().trim().max(60, "Keep the lead's name under 60 characters.");

adTeamsRouter.get("/ad-teams", async (req, res, next) => {
  try {
    if (!(await adTeamsReady())) return res.json({ ready: false, teams: [] });
    const { rows } = await pool.query(`${SELECT} where tm.org_id = $1 and tm.active order by tm.sort_order, lower(tm.name)`, [req.orgId]);
    res.json({ ready: true, teams: rows });
  } catch (err) { next(err); }
});

adTeamsRouter.post("/ad-teams", requirePermission("task_settings"), async (req, res, next) => {
  const parsed = z.object({ name, leadName: leadName.optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await adTeamsReady())) return res.status(409).json({ error: NEEDS_DB });
    // a removed team of the same name comes back, with its numbering
    const { rows: [old] } = await pool.query("select id from ad_team where org_id = $1 and lower(name) = lower($2)", [req.orgId, parsed.data.name]);
    const { rows: [made] } = old
      ? await pool.query("update ad_team set active = true, lead_name = coalesce($2, lead_name) where id = $1 returning id", [old.id, parsed.data.leadName ?? null])
      : await pool.query(
        `insert into ad_team (org_id, name, lead_name, sort_order)
         values ($1, $2, $3, (select coalesce(max(sort_order), 0) + 1 from ad_team where org_id = $1)) returning id`,
        [req.orgId, parsed.data.name, parsed.data.leadName ?? ""],
      );
    const { rows: [team] } = await pool.query(`${SELECT} where tm.id = $1`, [made.id]);
    res.status(old ? 200 : 201).json({ team });
  } catch (err) { next(err); }
});

adTeamsRouter.patch("/ad-teams/:id", requirePermission("task_settings"), async (req, res, next) => {
  const parsed = z.object({ name: name.optional(), leadName: leadName.optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await adTeamsReady())) return res.status(409).json({ error: NEEDS_DB });
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "No such team." });
    const { rowCount } = await pool.query(
      "update ad_team set name = coalesce($3, name), lead_name = coalesce($4, lead_name) where id = $1 and org_id = $2",
      [req.params.id, req.orgId, parsed.data.name ?? null, parsed.data.leadName ?? null],
    );
    if (!rowCount) return res.status(404).json({ error: "No such team." });
    const { rows: [team] } = await pool.query(`${SELECT} where tm.id = $1`, [req.params.id]);
    res.json({ team });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "There's already a team with that name." });
    next(err);
  }
});

adTeamsRouter.delete("/ad-teams/:id", requirePermission("task_settings"), async (req, res, next) => {
  try {
    if (!(await adTeamsReady())) return res.status(409).json({ error: NEEDS_DB });
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "No such team." });
    const { rowCount } = await pool.query("update ad_team set active = false where id = $1 and org_id = $2", [req.params.id, req.orgId]);
    if (!rowCount) return res.status(404).json({ error: "No such team." });
    res.status(204).end();
  } catch (err) { next(err); }
});
