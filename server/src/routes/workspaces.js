import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { createWorkspace } from "../bootstrap.js";

export const workspacesRouter = Router();

// List every workspace the authenticated user belongs to (for the switcher).
workspacesRouter.get("/workspaces", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select w.id, w.name, w.logo_url, m.role
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
workspacesRouter.post("/workspaces", async (req, res, next) => {
  const parsed = NameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Workspace name is required." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await createWorkspace(client, parsed.data.name, req.user.sub);
    await client.query("COMMIT");
    res.status(201).json({ workspace });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Rename a workspace the user is an admin of.
workspacesRouter.patch("/workspaces/:id", async (req, res, next) => {
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
