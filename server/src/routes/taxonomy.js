import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

export const taxonomyRouter = Router();

const PillarSchema = z.object({ name: z.string().min(1) });
const AvatarSchema = z.object({ name: z.string().min(1) });
const ContentTypeSchema = z.object({
  name: z.string().min(1),
  pillarId: z.string().uuid(),
});
const FormatSchema = z.object({
  name: z.string().min(1),
  pillarId: z.string().uuid(),
  postType: z.enum(["reel", "carousel"]),
});

function validate(schema, body, res) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return null;
  }
  return parsed.data;
}

// Postgres FK violation → the item is still referenced by posts.
function handleDeleteError(err, res, next, label) {
  if (err.code === "23503") {
    return res.status(409).json({
      error: `Can't delete this ${label} — it's still used by existing posts. Reassign or delete those posts first.`,
    });
  }
  next(err);
}

taxonomyRouter.post("/pillars", requireAdmin, async (req, res, next) => {
  const p = validate(PillarSchema, req.body, res);
  if (!p) return;
  try {
    const { rows } = await pool.query(
      `insert into pillar (workspace_id, name, sort_order)
       values ($1, $2, (select coalesce(max(sort_order), 0) + 1 from pillar where workspace_id = $1))
       returning id, name, sort_order, active`,
      [req.workspaceId, p.name],
    );
    res.status(201).json({ pillar: rows[0] });
  } catch (err) {
    next(err);
  }
});

taxonomyRouter.delete("/pillars/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from pillar where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (!rowCount) return res.status(404).json({ error: "Pillar not found" });
    res.status(204).end();
  } catch (err) {
    handleDeleteError(err, res, next, "pillar");
  }
});

taxonomyRouter.post("/avatars", requireAdmin, async (req, res, next) => {
  const p = validate(AvatarSchema, req.body, res);
  if (!p) return;
  try {
    const { rows } = await pool.query(
      `insert into avatar (workspace_id, name, sort_order)
       values ($1, $2, (select coalesce(max(sort_order), 0) + 1 from avatar where workspace_id = $1))
       returning id, name, sort_order, active`,
      [req.workspaceId, p.name],
    );
    res.status(201).json({ avatar: rows[0] });
  } catch (err) {
    next(err);
  }
});

taxonomyRouter.delete("/avatars/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from avatar where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (!rowCount) return res.status(404).json({ error: "Avatar not found" });
    res.status(204).end();
  } catch (err) {
    handleDeleteError(err, res, next, "avatar");
  }
});

taxonomyRouter.post("/content-types", requireAdmin, async (req, res, next) => {
  const p = validate(ContentTypeSchema, req.body, res);
  if (!p) return;
  try {
    const { rows } = await pool.query(
      `insert into content_type (workspace_id, pillar_id, name)
       values ($1, $2, $3)
       returning id, pillar_id, name, active`,
      [req.workspaceId, p.pillarId, p.name],
    );
    res.status(201).json({ contentType: rows[0] });
  } catch (err) {
    next(err);
  }
});

taxonomyRouter.delete("/content-types/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from content_type where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (!rowCount) return res.status(404).json({ error: "Content type not found" });
    res.status(204).end();
  } catch (err) {
    handleDeleteError(err, res, next, "content type");
  }
});

taxonomyRouter.post("/formats", requireAdmin, async (req, res, next) => {
  const p = validate(FormatSchema, req.body, res);
  if (!p) return;
  try {
    const { rows } = await pool.query(
      `insert into format (workspace_id, pillar_id, name, post_type)
       values ($1, $2, $3, $4)
       returning id, pillar_id, name, post_type, active`,
      [req.workspaceId, p.pillarId, p.name, p.postType],
    );
    res.status(201).json({ format: rows[0] });
  } catch (err) {
    next(err);
  }
});

taxonomyRouter.delete("/formats/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from format where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (!rowCount) return res.status(404).json({ error: "Format not found" });
    res.status(204).end();
  } catch (err) {
    handleDeleteError(err, res, next, "format");
  }
});
