import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

export const editorsRouter = Router();

const EditorSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  // Small resized data URL (or "" to clear); downscaled client-side.
  imageUrl: z.string().max(2_000_000).optional(),
});

const EDITOR_COLUMNS = "id, name, designation, image_url, active";

editorsRouter.get("/editors", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${EDITOR_COLUMNS} from editor where workspace_id = $1 order by name`,
      [req.workspaceId],
    );
    res.json({ editors: rows });
  } catch (err) {
    next(err);
  }
});

editorsRouter.post("/editors", requireAdmin, async (req, res, next) => {
  const parsed = EditorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  try {
    const { rows } = await pool.query(
      `insert into editor (workspace_id, name, designation, image_url)
       values ($1, $2, $3, $4)
       returning ${EDITOR_COLUMNS}`,
      [
        req.workspaceId,
        parsed.data.name,
        parsed.data.designation ?? "",
        parsed.data.imageUrl || null,
      ],
    );
    res.status(201).json({ editor: rows[0] });
  } catch (err) {
    next(err);
  }
});

editorsRouter.patch("/editors/:id", requireAdmin, async (req, res, next) => {
  const parsed = EditorSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const sets = [];
  const params = [req.params.id, req.workspaceId];
  for (const [key, col] of [["name", "name"], ["designation", "designation"], ["imageUrl", "image_url"]]) {
    if (parsed.data[key] === undefined) continue;
    params.push(key === "imageUrl" ? parsed.data[key] || null : parsed.data[key]);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "No fields to update" });
  try {
    const { rows } = await pool.query(
      `update editor set ${sets.join(", ")}
       where id = $1 and workspace_id = $2
       returning ${EDITOR_COLUMNS}`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: "Editor not found" });
    res.json({ editor: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Remove an editor. Posts they edited keep their history — post.editor_id is
// ON DELETE SET NULL, so those posts simply become unassigned.
editorsRouter.delete("/editors/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from editor where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (!rowCount) return res.status(404).json({ error: "Editor not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
