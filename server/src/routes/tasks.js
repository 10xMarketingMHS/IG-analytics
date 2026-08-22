import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { logActivity } from "../activity.js";

export const tasksRouter = Router();

const STATUS = ["todo", "in_progress", "review", "done"];
const PRIORITY = ["low", "medium", "high"];
const PLATFORMS = ["instagram", "facebook", "youtube"];

const TaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  editorId: z.string().uuid().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
  dueDate: z.string().optional().nullable(), // YYYY-MM-DD
  status: z.enum(STATUS).optional(),
  priority: z.enum(PRIORITY).optional(),
  recurrence: z.enum(["none", "daily", "weekly"]).optional(),
  // Phase 1 additions. content_type is a flexible tag (UI drives the list).
  contentType: z.string().max(40).nullable().optional(),
  platforms: z.array(z.enum(PLATFORMS)).optional(),
  attachments: z.array(z.object({ url: z.string().url(), label: z.string().max(120).optional() })).optional(),
});

// Returned shape: task fields + assignee name/image + channel name for the UI.
const SELECT = `
  select t.id, t.serial, t.title, t.description, t.editor_id, t.channel_id, t.post_id,
         t.status, t.priority, t.due_date, t.recurrence, t.created_at, t.completed_at,
         t.content_type, t.platforms, t.attachments,
         e.name as editor_name, e.image_url as editor_image,
         w.name as channel_name,
         (select count(*)::int from subtask s where s.task_id = t.id) as subtask_total,
         (select count(*)::int from subtask s where s.task_id = t.id and s.done) as subtask_done
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
    // Atomically claim the next per-org Task ID and insert in one statement.
    const { rows } = await pool.query(
      `with s as (update org set task_seq = task_seq + 1 where id = $1 returning task_seq)
       insert into task (org_id, editor_id, channel_id, title, description,
                         status, priority, due_date, recurrence,
                         content_type, platforms, attachments, serial, completed_at)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, (select task_seq from s),
              case when $6 = 'done' then now() else null end
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
        d.recurrence ?? "none",
        d.contentType ?? null,
        d.platforms ?? [],
        JSON.stringify(d.attachments ?? []),
      ],
    );
    const { rows: full } = await pool.query(`${SELECT} where t.id = $1`, [rows[0].id]);
    await logActivity({
      orgId: req.orgId,
      actorId: req.user.sub,
      verb: "created",
      entityType: "task",
      entityId: full[0].id,
      channelId: full[0].channel_id,
      summary: `Created task “${full[0].title}”`,
    });
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
  if (d.recurrence !== undefined) push("recurrence", d.recurrence);
  if (d.contentType !== undefined) push("content_type", d.contentType ?? null);
  if (d.platforms !== undefined) push("platforms", d.platforms);
  if (d.attachments !== undefined) {
    params.push(JSON.stringify(d.attachments));
    sets.push(`attachments = $${params.length}::jsonb`);
  }
  if (d.status !== undefined) {
    push("status", d.status);
    // Stamp/clear completion time as status moves in/out of "done".
    sets.push(`completed_at = case when $${params.length} = 'done' then coalesce(completed_at, now()) else null end`);
  }
  if (!sets.length) return res.status(400).json({ error: "No fields to update" });
  try {
    // Capture prior state so we can spawn the next occurrence on completion.
    const prior = (await pool.query("select status, recurrence from task where id = $1 and org_id = $2", [req.params.id, req.orgId])).rows[0];
    if (!prior) return res.status(404).json({ error: "Task not found" });

    const { rows } = await pool.query(
      `update task set ${sets.join(", ")} where id = $1 and org_id = $2 returning id`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: "Task not found" });

    const finalStatus = d.status ?? prior.status;
    const finalRecurrence = d.recurrence ?? prior.recurrence;
    if (prior.status !== "done" && finalStatus === "done" && finalRecurrence !== "none") {
      await spawnNextOccurrence(req.params.id, finalRecurrence);
    }

    const { rows: full } = await pool.query(`${SELECT} where t.id = $1`, [req.params.id]);
    // Log the moment a task is marked complete.
    if (prior.status !== "done" && finalStatus === "done") {
      await logActivity({
        orgId: req.orgId,
        actorId: req.user.sub,
        verb: "completed",
        entityType: "task",
        entityId: full[0].id,
        channelId: full[0].channel_id,
        summary: `Completed task “${full[0].title}”`,
      });
    }
    res.json({ task: full[0] });
  } catch (err) {
    next(err);
  }
});

// When a recurring task is completed, create its next occurrence (fresh, To Do,
// due date advanced) and copy its checklist items unchecked.
async function spawnNextOccurrence(taskId, recurrence) {
  try {
    const t = (await pool.query(
      "select org_id, editor_id, channel_id, title, description, priority, due_date from task where id = $1",
      [taskId],
    )).rows[0];
    if (!t) return;
    const days = recurrence === "weekly" ? 7 : 1;
    // Advance from the current due date if set, else from today.
    const nextDue = `(coalesce($7::date, current_date) + interval '${days} day')::date`;
    const { rows } = await pool.query(
      `insert into task (org_id, editor_id, channel_id, title, description, priority, due_date, recurrence, status)
       values ($1,$2,$3,$4,$5,$6, ${nextDue}, $8, 'todo') returning id`,
      [t.org_id, t.editor_id, t.channel_id, t.title, t.description, t.priority, t.due_date, recurrence],
    );
    const newId = rows[0].id;
    await pool.query(
      "insert into subtask (task_id, title, sort_order) select $1, title, sort_order from subtask where task_id = $2",
      [newId, taskId],
    );
  } catch (err) {
    console.error("spawnNextOccurrence failed:", err.message);
  }
}

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

// ---- Subtasks (checklist) ----
// A subtask is only reachable through its parent task, which must be in the org.
async function ownsTask(taskId, orgId) {
  const { rows } = await pool.query("select 1 from task where id = $1 and org_id = $2", [taskId, orgId]);
  return rows.length > 0;
}

tasksRouter.get("/tasks/:id/subtasks", async (req, res, next) => {
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    const { rows } = await pool.query(
      "select id, title, done, sort_order from subtask where task_id = $1 order by sort_order, created_at",
      [req.params.id],
    );
    res.json({ subtasks: rows });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/tasks/:id/subtasks", requireEditor, async (req, res, next) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "A checklist item needs a title." });
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    const { rows } = await pool.query(
      `insert into subtask (task_id, title, sort_order)
       values ($1, $2, (select coalesce(max(sort_order), 0) + 1 from subtask where task_id = $1))
       returning id, title, done, sort_order`,
      [req.params.id, title],
    );
    res.status(201).json({ subtask: rows[0] });
  } catch (err) {
    next(err);
  }
});

tasksRouter.patch("/subtasks/:id", requireEditor, async (req, res, next) => {
  const sets = [];
  const params = [req.params.id, req.orgId];
  if (typeof req.body?.done === "boolean") { params.push(req.body.done); sets.push(`done = $${params.length}`); }
  if (typeof req.body?.title === "string" && req.body.title.trim()) { params.push(req.body.title.trim()); sets.push(`title = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  try {
    const { rows } = await pool.query(
      `update subtask set ${sets.join(", ")}
       where id = $1 and task_id in (select id from task where org_id = $2)
       returning id, title, done, sort_order`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: "Checklist item not found" });
    res.json({ subtask: rows[0] });
  } catch (err) {
    next(err);
  }
});

tasksRouter.delete("/subtasks/:id", requireEditor, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from subtask where id = $1 and task_id in (select id from task where org_id = $2)",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Checklist item not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Comments (discussion thread) ----
tasksRouter.get("/tasks/:id/comments", async (req, res, next) => {
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    const { rows } = await pool.query(
      `select c.id, c.body, c.created_at, c.author_id,
              coalesce(u.name, u.email) as author_name
         from task_comment c
         left join app_user u on u.id = c.author_id
        where c.task_id = $1
        order by c.created_at asc`,
      [req.params.id],
    );
    res.json({ comments: rows });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/tasks/:id/comments", async (req, res, next) => {
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "Write a comment first." });
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    const { rows } = await pool.query(
      `insert into task_comment (task_id, author_id, body) values ($1, $2, $3) returning id, body, created_at, author_id`,
      [req.params.id, req.user.sub, body],
    );
    const author = (await pool.query("select coalesce(name, email) as n from app_user where id = $1", [req.user.sub])).rows[0];
    const t = (await pool.query("select title, channel_id from task where id = $1", [req.params.id])).rows[0];
    await logActivity({
      orgId: req.orgId,
      actorId: req.user.sub,
      verb: "commented",
      entityType: "task",
      entityId: req.params.id,
      channelId: t?.channel_id ?? null,
      summary: `Commented on “${t?.title ?? "a task"}”`,
    });
    res.status(201).json({ comment: { ...rows[0], author_name: author?.n ?? null } });
  } catch (err) {
    next(err);
  }
});

// Delete a comment — the author or an admin.
tasksRouter.delete("/comments/:id", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `delete from task_comment
        where id = $1
          and task_id in (select id from task where org_id = $2)
          and (author_id = $3 or $4 = 'admin')`,
      [req.params.id, req.orgId, req.user.sub, req.role],
    );
    if (!rowCount) return res.status(404).json({ error: "Comment not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
