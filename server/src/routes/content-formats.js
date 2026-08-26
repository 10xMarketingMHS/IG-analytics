import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

export const contentFormatsRouter = Router();

const Schema = z.object({
  name: z.string().trim().min(1).max(40),
  icon: z.string().trim().min(1).max(8).optional(),
  // Points Formula base_points for this format — how much a task in it is
  // worth before the on-time/late timing multiplier applies. Independent of
  // budget_hours (task-rules.js) — a format's point value and its time
  // budget are two separate admin decisions.
  points: z.number().nonnegative().max(1000).optional(),
});

const SELECT = "id, name, icon, sort_order, active, points";

// Org-wide, like editors — every channel picks from the same list.
contentFormatsRouter.get("/content-formats", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${SELECT} from task_content_format where org_id = $1 and active order by sort_order, name`,
      [req.orgId],
    );
    res.json({ contentFormats: rows });
  } catch (err) {
    next(err);
  }
});

contentFormatsRouter.post("/content-formats", requireAdmin, async (req, res, next) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the format a name." });
  try {
    const { rows: maxRow } = await pool.query(
      "select coalesce(max(sort_order), 0) + 1 as n from task_content_format where org_id = $1",
      [req.orgId],
    );
    const { rows } = await pool.query(
      `insert into task_content_format (org_id, name, icon, sort_order)
       values ($1, $2, $3, $4) returning ${SELECT}`,
      [req.orgId, parsed.data.name, parsed.data.icon || "🔧", maxRow[0].n],
    );
    res.status(201).json({ contentFormat: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That format already exists." });
    next(err);
  }
});

contentFormatsRouter.patch("/content-formats/:id", requireAdmin, async (req, res, next) => {
  const parsed = Schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update." });
  const sets = [];
  const vals = [];
  if (parsed.data.name !== undefined) { vals.push(parsed.data.name); sets.push(`name = $${vals.length}`); }
  if (parsed.data.icon !== undefined) { vals.push(parsed.data.icon); sets.push(`icon = $${vals.length}`); }
  if (parsed.data.points !== undefined) { vals.push(parsed.data.points); sets.push(`points = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  vals.push(req.params.id, req.orgId);
  try {
    const { rows } = await pool.query(
      `update task_content_format set ${sets.join(", ")}
       where id = $${vals.length - 1} and org_id = $${vals.length} returning ${SELECT}`,
      vals,
    );
    if (!rows.length) return res.status(404).json({ error: "Format not found." });
    res.json({ contentFormat: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That format already exists." });
    next(err);
  }
});

// Soft-delete — tasks and rules already using it keep displaying correctly
// (name/icon still resolve); it just stops being offered for new ones.
contentFormatsRouter.delete("/content-formats/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "update task_content_format set active = false where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Format not found." });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
