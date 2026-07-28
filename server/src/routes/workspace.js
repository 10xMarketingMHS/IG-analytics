import { Router } from "express";
import { pool } from "../db.js";

export const workspaceRouter = Router();

workspaceRouter.get("/workspace", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "select id, name, logo_url, brand_colors from workspace where id = $1",
      [req.workspaceId],
    );
    res.json({ workspace: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

workspaceRouter.get("/taxonomy", async (req, res, next) => {
  try {
    // Bulk entry needs each row's channel taxonomy: ?channel=<id> (validated to
    // the org) overrides the active channel.
    let workspaceId = req.workspaceId;
    if (req.query.channel && req.query.channel !== req.workspaceId) {
      const ok = await pool.query(
        "select 1 from workspace where id = $1 and org_id = $2",
        [req.query.channel, req.orgId],
      );
      if (ok.rows.length) workspaceId = req.query.channel;
    }
    const [pillars, avatars, contentTypes, formats] = await Promise.all([
      pool.query(
        "select id, name, sort_order, active from pillar where workspace_id = $1 order by sort_order",
        [workspaceId],
      ),
      pool.query(
        "select id, name, sort_order, active from avatar where workspace_id = $1 order by sort_order",
        [workspaceId],
      ),
      pool.query(
        "select id, pillar_id, name, active from content_type where workspace_id = $1 order by name",
        [workspaceId],
      ),
      pool.query(
        "select id, pillar_id, name, post_type, active from format where workspace_id = $1 order by name",
        [workspaceId],
      ),
    ]);

    res.json({
      pillars: pillars.rows,
      avatars: avatars.rows,
      contentTypes: contentTypes.rows,
      formats: formats.rows,
    });
  } catch (err) {
    next(err);
  }
});

workspaceRouter.get("/scoring-config", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "select post_type, weights from scoring_config where workspace_id = $1",
      [req.workspaceId],
    );
    res.json({ scoringConfig: rows });
  } catch (err) {
    next(err);
  }
});
