import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";

export const tasksRouter = Router();

const STATUS = ["todo", "in_progress", "done"];
const PRIORITY = ["low", "medium", "high"];

const TaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  editorId: z.string().uuid().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
  dueDate: z.string().optional().nullable(), // YYYY-MM-DD
  status: z.enum(STATUS).optional(),
  priority: z.enum(PRIORITY).optional(),
});

// Returned shape: task fields + assignee name/image + channel name for the UI.
const SELECT = `
  select t.id, t.title, t.description, t.editor_id, t.channel_id, t.post_id,
         t.status, t.priority, t.due_date, t.created_at, t.completed_at,
         e.name as editor_name, e.image_url as editor_image,
         w.name as channel_name
    from task t
    left join editor e on e.id = t.editor_id
    left join workspace w on w.id = t.channel_id`;

// List every task in the org, newest-relevant first. Optional filters.
tasksRouter.get("/tasks", async (req, res, next) => {
  try {
    const clauses = ["t.org_id = $1"];
    const params = [req.orgId];
    if (req.query.editorId) {
      params.push(req.query.editorId);
      clauses.push(`t.editor_id = $${params.length}`);
    }
    if (req.query.status && STATUS.includes(req.query.status)) {
      params.push(req.query.status);
      clauses.push(`t.status = $${params.length}`);
    }
    const { rows } = await pool.query(
      `${SELECT} where ${clauses.join(" and ")}
       order by t.due_date asc nulls last, t.created_at desc`,
      params,
    );
    res.json({ tasks: rows });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/tasks", requireEditor, async (req, res, next) => {
  const parsed = TaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const d = parsed.data;
  try {
    const status = d.status ?? "todo";
    const { rows } = await pool.query(
      `insert into task (org_id, editor_id, channel_id, title, description,
                         status, priority, due_date, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, case when $6 = 'done' then now() else null end)
       returning id`,
      [
        req.orgId,
        d.editorId ?? null,
        d.channelId ?? null,
        d.title,
        d.description ?? "",
        status,
        d.priority ?? "medium",
        d.dueDate || null,
      ],
    );
    const { rows: full } = await pool.query(`${SELECT} where t.id = $1`, [rows[0].id]);
    res.status(201).json({ task: full[0] });
  } catch (err) {
    next(err);
  }
});

tasksRouter.patch("/tasks/:id", requireEditor, async (req, res, next) => {
  const parsed = TaskSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const d = parsed.data;
  const sets = [];
  const params = [req.params.id, req.orgId];
  const push = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (d.title !== undefined) push("title", d.title);
  if (d.description !== undefined) push("description", d.description);
  if (d.editorId !== undefined) push("editor_id", d.editorId ?? null);
  if (d.channelId !== undefined) push("channel_id", d.channelId ?? null);
  if (d.priority !== undefined) push("priority", d.priority);
  if (d.dueDate !== undefined) push("due_date", d.dueDate || null);
  if (d.status !== undefined) {
    push("status", d.status);
    // Stamp/clear completion time as status moves in/out of "done".
    sets.push(`completed_at = case when $${params.length} = 'done' then coalesce(completed_at, now()) else null end`);
  }
  if (!sets.length) return res.status(400).json({ error: "No fields to update" });
  try {
    const { rows } = await pool.query(
      `update task set ${sets.join(", ")} where id = $1 and org_id = $2 returning id`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    const { rows: full } = await pool.query(`${SELECT} where t.id = $1`, [req.params.id]);
    res.json({ task: full[0] });
  } catch (err) {
    next(err);
  }
});

tasksRouter.delete("/tasks/:id", requireEditor, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Task not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
