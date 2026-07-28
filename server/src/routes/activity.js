import { Router } from "express";
import { pool } from "../db.js";

export const activityRouter = Router();

// Recent activity across the org, newest first. Optional ?channel=<id> filter
// and ?limit= (capped). Joins the actor's name for display.
activityRouter.get("/activity", async (req, res, next) => {
  try {
    const params = [req.orgId];
    let where = "a.org_id = $1";
    if (req.query.channel && req.query.channel !== "all") {
      params.push(req.query.channel);
      where += ` and a.channel_id = $${params.length}`;
    }
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    params.push(limit);
    const { rows } = await pool.query(
      `select a.id, a.verb, a.entity_type, a.entity_id, a.channel_id,
              a.summary, a.meta, a.created_at,
              coalesce(u.name, u.email) as actor_name,
              w.name as channel_name
         from activity a
         left join app_user u on u.id = a.actor_id
         left join workspace w on w.id = a.channel_id
        where ${where}
        order by a.created_at desc
        limit $${params.length}`,
      params,
    );
    res.json({ activity: rows });
  } catch (err) {
    next(err);
  }
});
