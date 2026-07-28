import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

export const platformsRouter = Router();

// All platforms (dashboard cards, Add Post picker).
platformsRouter.get("/platforms", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "select id, key, name, sort_order from platform where active order by sort_order",
    );
    res.json({ platforms: rows });
  } catch (err) {
    next(err);
  }
});

// The account grid for the org: which channels are on which platforms.
// ?channel=<workspaceId> narrows to one channel.
platformsRouter.get("/accounts", async (req, res, next) => {
  try {
    const params = [req.orgId];
    let where = "a.org_id = $1 and a.active";
    if (req.query.channel && req.query.channel !== "all") {
      params.push(req.query.channel);
      where += ` and a.workspace_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `select a.id, a.workspace_id as channel_id, w.name as channel_name,
              a.platform_id, p.key as platform_key, p.name as platform_name, p.sort_order,
              a.handle
         from account a
         join workspace w on w.id = a.workspace_id
         join platform p on p.id = a.platform_id
        where ${where}
        order by w.name, p.sort_order`,
      params,
    );
    res.json({ accounts: rows });
  } catch (err) {
    next(err);
  }
});

const AccountSchema = z.object({
  channelId: z.string().uuid(),
  platformId: z.string().uuid(),
  handle: z.string().optional(),
});

// Enable a platform on a channel (creates the account).
platformsRouter.post("/accounts", requireAdmin, async (req, res, next) => {
  const parsed = AccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const { channelId, platformId, handle } = parsed.data;
  try {
    // Channel must belong to the caller's org.
    const ok = await pool.query(
      "select 1 from workspace where id = $1 and org_id = $2",
      [channelId, req.orgId],
    );
    if (!ok.rows.length) return res.status(400).json({ error: "Unknown channel" });

    const { rows } = await pool.query(
      `insert into account (org_id, workspace_id, platform_id, handle)
       values ($1, $2, $3, $4)
       on conflict (workspace_id, platform_id) do update set active = true, handle = coalesce(excluded.handle, account.handle)
       returning id`,
      [req.orgId, channelId, platformId, handle ?? null],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

// Disable a platform on a channel. Blocked if that account already has posts.
platformsRouter.delete("/accounts/:id", requireAdmin, async (req, res, next) => {
  try {
    const acc = await pool.query(
      "select workspace_id, platform_id from account where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!acc.rows.length) return res.status(404).json({ error: "Account not found" });
    const { workspace_id, platform_id } = acc.rows[0];
    const used = await pool.query(
      "select 1 from post where workspace_id = $1 and platform_id = $2 and deleted_at is null limit 1",
      [workspace_id, platform_id],
    );
    if (used.rows.length) {
      return res.status(409).json({ error: "This platform has posts — can't remove it." });
    }
    await pool.query("delete from account where id = $1 and org_id = $2", [req.params.id, req.orgId]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
