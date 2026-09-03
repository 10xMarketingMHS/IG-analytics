import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { createWorkspace } from "../bootstrap.js";
import { logActivity } from "../activity.js";
import { requireAdmin } from "../resolve-workspace.js";

export const workspacesRouter = Router();

// List every workspace the authenticated user belongs to (for the switcher).
workspacesRouter.get("/workspaces", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select w.id, w.name, w.logo_url, m.role,
              coalesce((
                select array_agg(g.permission_key)
                from user_permission_grant g
                where g.org_id = w.org_id and g.user_id = m.user_id and g.revoked_at is null
              ), '{}') as permissions
       from workspace w
       join membership m on m.workspace_id = w.id
       where m.user_id = $1
       order by w.created_at asc`,
      [req.user.sub],
    );
    res.json({ workspaces: rows });
  } catch (err) {
    next(err);
  }
});

const NameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Create a new workspace — the creator becomes its admin.
workspacesRouter.post("/workspaces", requireAdmin, async (req, res, next) => {
  const parsed = NameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Workspace name is required." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Resolve the caller's org + an existing channel to copy taxonomy from.
    const ctx = await client.query(
      `select w.id as ws_id, w.org_id from workspace w
       join membership m on m.workspace_id = w.id
       where m.user_id = $1 and w.org_id is not null
       order by w.created_at asc limit 1`,
      [req.user.sub],
    );
    let orgId = ctx.rows[0]?.org_id ?? null;
    const sourceWorkspaceId = ctx.rows[0]?.ws_id ?? null;
    if (!orgId) orgId = (await client.query("select id from org order by created_at limit 1")).rows[0]?.id ?? null;

    const workspace = await createWorkspace(client, parsed.data.name, req.user.sub, { orgId, sourceWorkspaceId });

    // Enable Instagram by default so the new channel is immediately usable.
    if (orgId) {
      const ig = await client.query("select id from platform where key = 'instagram'");
      if (ig.rows[0]) {
        await client.query(
          `insert into account (org_id, workspace_id, platform_id, handle)
           values ($1,$2,$3,$4) on conflict (workspace_id, platform_id) do nothing`,
          [orgId, workspace.id, ig.rows[0].id, "@" + parsed.data.name],
        );
      }
    }
    await client.query("COMMIT");
    if (orgId) {
      await logActivity({
        orgId, actorId: req.user.sub, verb: "channel_added",
        entityType: "channel", entityId: workspace.id, channelId: workspace.id,
        summary: `Added channel “${workspace.name}”`,
      });
    }
    res.status(201).json({ workspace });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Rename a workspace the user is an admin of.
workspacesRouter.patch("/workspaces/:id", requireAdmin, async (req, res, next) => {
  const parsed = NameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Workspace name is required." });
  }
  try {
    const { rows } = await pool.query(
      `update workspace set name = $1, updated_at = now()
       where id = $2
         and exists (
           select 1 from membership m
           where m.workspace_id = workspace.id and m.user_id = $3 and m.role = 'admin'
         )
       returning id, name, logo_url`,
      [parsed.data.name, req.params.id, req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: "Workspace not found" });
    res.json({ workspace: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Delete a channel the user is an admin of. Cascades its posts, platform
// accounts, taxonomy, memberships & Instagram connections; keeps the shared
// team (editors are reassigned to another channel) and keeps tasks (their
// channel link is just cleared). Refuses to delete the org's only channel.
workspacesRouter.delete("/workspaces/:id", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ws = (await client.query(
      `select w.id, w.org_id from workspace w
       join membership m on m.workspace_id = w.id
       where w.id = $1 and m.user_id = $2 and m.role = 'admin'`,
      [req.params.id, req.user.sub],
    )).rows[0];
    if (!ws) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Channel not found" });
    }
    // A landing spot for the shared team + a guard against deleting the last one.
    const other = (await client.query(
      "select id from workspace where org_id = $1 and id <> $2 order by created_at asc limit 1",
      [ws.org_id, ws.id],
    )).rows[0];
    if (!other) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This is your only channel — you can't delete it." });
    }
    // Editors are the org's shared team (NOT NULL workspace_id cascades) — move
    // them to another channel so they survive.
    await client.query("update editor set workspace_id = $1 where workspace_id = $2", [other.id, ws.id]);
    await client.query("delete from workspace where id = $1", [ws.id]);
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});
