import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

export const taskRulesRouter = Router();

const CONTENT_FORMAT = ["video", "image", "shoot", "other"];

// Time-budget rules (Phase 1) are entirely admin-configured — editors can see
// their own resolved budget on a task, but never edit the rule itself.
taskRulesRouter.use(requireAdmin);

const SELECT = `
  select r.id, r.content_format, r.editor_id, r.hours, r.updated_at,
         e.name as editor_name
    from task_time_rule r
    left join editor e on e.id = r.editor_id`;

// List every rule for the org — global defaults (editor_id null) and
// per-editor overrides, newest-updated first within each format.
taskRulesRouter.get("/task-time-rules", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `${SELECT} where r.org_id = $1 order by r.content_format, e.name nulls first`,
      [req.orgId],
    );
    res.json({ rules: rows });
  } catch (err) {
    next(err);
  }
});

const RuleSchema = z.object({
  contentFormat: z.enum(CONTENT_FORMAT),
  editorId: z.string().uuid().nullable().optional(), // omitted/null = global default
  hours: z.number().positive().max(999),
});

// Upsert — one row per (org, format, editor|global). Setting a rule for a
// format+editor that already has one just updates its hours.
taskRulesRouter.post("/task-time-rules", async (req, res, next) => {
  const parsed = RuleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const { contentFormat, hours } = parsed.data;
  const editorId = parsed.data.editorId ?? null;
  try {
    if (editorId) {
      const { rows: erows } = await pool.query("select 1 from editor where id = $1 and org_id = $2", [editorId, req.orgId]);
      if (!erows.length) return res.status(400).json({ error: "That team member wasn't found." });
    }
    const conflictTarget = editorId
      ? "(org_id, content_format, editor_id) where editor_id is not null"
      : "(org_id, content_format) where editor_id is null";
    const { rows } = await pool.query(
      `insert into task_time_rule (org_id, content_format, editor_id, hours)
       values ($1, $2, $3, $4)
       on conflict ${conflictTarget}
       do update set hours = excluded.hours, updated_at = now()
       returning id`,
      [req.orgId, contentFormat, editorId, hours],
    );
    const { rows: full } = await pool.query(`${SELECT} where r.id = $1`, [rows[0].id]);
    res.status(201).json({ rule: full[0] });
  } catch (err) {
    next(err);
  }
});

taskRulesRouter.delete("/task-time-rules/:id", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from task_time_rule where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Rule not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
