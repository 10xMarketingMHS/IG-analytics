import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { logActivity } from "../activity.js";

export const tasksRouter = Router();

const STATUS = ["todo", "in_progress", "done"];
const PRIORITY = ["low", "medium", "high"];
// What *kind* of task this is — separate from priority (how urgent). Auto-
// created (post-linked) tasks are always "content" and that's not user-editable.
const TASK_TYPE = ["content", "short_task", "emergency", "general"];
// A second, independent classifier: what production format the work is.
// Optional — not every task (e.g. an emergency or general task) has one.
const CONTENT_FORMAT = ["video", "image", "shoot", "other"];

const TaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  editorId: z.string().uuid().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
  postId: z.string().uuid().nullable().optional(),
  dueDate: z.string().optional().nullable(), // YYYY-MM-DD
  status: z.enum(STATUS).optional(),
  priority: z.enum(PRIORITY).optional(),
  recurrence: z.enum(["none", "daily", "weekly"]).optional(),
  taskType: z.enum(TASK_TYPE).optional(),
  contentFormat: z.enum(CONTENT_FORMAT).nullable().optional(),
});

// Returned shape: task fields + assignee name/image + channel name for the UI.
// Social Media tasks (post_id set) also carry the post's title, permalink and
// platform (account context) — a manual task has none of that, all null.
const SELECT = `
  select t.id, t.title, t.description, t.editor_id, t.channel_id, t.post_id,
         t.status, t.priority, t.due_date, t.recurrence, t.task_type, t.content_format,
         t.budget_hours, t.budget_started_at, t.accepted, t.created_at, t.completed_at,
         e.name as editor_name, e.image_url as editor_image,
         w.name as channel_name,
         p.title as post_title, p.permalink as post_permalink,
         pl.key as platform_key, pl.name as platform_name,
         (select count(*)::int from subtask s where s.task_id = t.id) as subtask_total,
         (select count(*)::int from subtask s where s.task_id = t.id and s.done) as subtask_done
    from task t
    left join editor e on e.id = t.editor_id
    left join workspace w on w.id = t.channel_id
    left join post p on p.id = t.post_id
    left join platform pl on pl.id = p.platform_id`;

// Time-budget resolution (Phase 1): an editor's own rule for a format wins,
// else the org-wide default, else no budget (task just has no timer).
async function resolveBudgetHours(orgId, editorId, contentFormat) {
  if (!contentFormat) return null;
  const { rows } = await pool.query(
    `select hours from task_time_rule
      where org_id = $1 and content_format = $2 and editor_id = $3
      union all
      select hours from task_time_rule
      where org_id = $1 and content_format = $2 and editor_id is null
      limit 1`,
    [orgId, contentFormat, editorId],
  );
  return rows[0]?.hours ?? null;
}

// Whichever editor the caller's own login is linked to (§ My Tasks / § Accept).
async function callerEditorId(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}

// List every task in the org, newest-relevant first. Optional filters:
//   editorId=<uuid>   — a specific assignee
//   assignee=me        — tasks assigned to the caller's linked editor (§ My Tasks)
//   status=<status>
//   taskType=<type>
//   dueBefore/dueAfter — YYYY-MM-DD, inclusive, for due-date range views
//   socialMedia=1       — only post-linked tasks (§ Social Media tracking)
tasksRouter.get("/tasks", async (req, res, next) => {
  try {
    const clauses = ["t.org_id = $1"];
    const params = [req.orgId];
    if (req.query.socialMedia === "1") clauses.push("t.post_id is not null");

    if (req.query.assignee === "me") {
      const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
      // No linked editor → "my tasks" is an empty set, not "all tasks".
      params.push(rows[0]?.editor_id ?? "00000000-0000-0000-0000-000000000000");
      clauses.push(`t.editor_id = $${params.length}`);
    } else if (req.query.editorId) {
      params.push(req.query.editorId);
      clauses.push(`t.editor_id = $${params.length}`);
    }
    if (req.query.status && STATUS.includes(req.query.status)) {
      params.push(req.query.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (req.query.taskType && TASK_TYPE.includes(req.query.taskType)) {
      params.push(req.query.taskType);
      clauses.push(`t.task_type = $${params.length}`);
    }
    if (req.query.contentFormat && CONTENT_FORMAT.includes(req.query.contentFormat)) {
      params.push(req.query.contentFormat);
      clauses.push(`t.content_format = $${params.length}`);
    }
    if (req.query.dueBefore) {
      params.push(req.query.dueBefore);
      clauses.push(`t.due_date <= $${params.length}`);
    }
    if (req.query.dueAfter) {
      params.push(req.query.dueAfter);
      clauses.push(`t.due_date >= $${params.length}`);
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
    const assigneeId = d.editorId ?? null;
    // Assigning to yourself accepts immediately (timer starts now); assigning
    // to someone else needs their explicit accept before the timer starts.
    const accepted = !assigneeId || (await callerEditorId(req)) === assigneeId;
    const budgetHours = await resolveBudgetHours(req.orgId, assigneeId, d.contentFormat ?? null);
    const { rows } = await pool.query(
      `insert into task (org_id, editor_id, channel_id, title, description,
                         status, priority, due_date, recurrence, task_type, content_format,
                         budget_hours, accepted, budget_started_at, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, case when $12 is not null and $13 then now() else null end,
               case when $6 = 'done' then now() else null end)
       returning id`,
      [
        req.orgId,
        assigneeId,
        d.channelId ?? null,
        d.title,
        d.description ?? "",
        status,
        d.priority ?? "medium",
        d.dueDate || null,
        d.recurrence ?? "none",
        // This endpoint is for manual tasks only (auto-created ones are
        // inserted directly by syncPostTask) — default to "general".
        d.taskType ?? "general",
        d.contentFormat ?? null,
        budgetHours,
        accepted,
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
  if (d.channelId !== undefined) push("channel_id", d.channelId ?? null);
  if (d.priority !== undefined) push("priority", d.priority);
  if (d.dueDate !== undefined) push("due_date", d.dueDate || null);
  if (d.recurrence !== undefined) push("recurrence", d.recurrence);
  if (d.status !== undefined) {
    push("status", d.status);
    // Stamp/clear completion time as status moves in/out of "done".
    sets.push(`completed_at = case when $${params.length} = 'done' then coalesce(completed_at, now()) else null end`);
  }
  try {
    // Capture prior state so we can spawn the next occurrence on completion,
    // guard task_type for post-linked tasks, and re-resolve the time budget.
    const prior = (await pool.query(
      "select status, recurrence, post_id, editor_id, content_format, accepted from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!prior) return res.status(404).json({ error: "Task not found" });

    // Manually linking a task to a post — turns it into a Social Media task
    // (§ splitting). Only for tasks that aren't already post-linked; only to
    // posts that don't already have their own linked task.
    if (d.postId !== undefined) {
      if (prior.post_id) {
        return res.status(400).json({ error: "This task is already linked to a post." });
      }
      if (d.postId) {
        const { rows: prows } = await pool.query(
          "select id from post p join workspace w on w.id = p.workspace_id where p.id = $1 and w.org_id = $2 and p.deleted_at is null",
          [d.postId, req.orgId],
        );
        if (!prows.length) return res.status(400).json({ error: "That post wasn't found." });
        const { rows: existing } = await pool.query("select id from task where post_id = $1", [d.postId]);
        if (existing.length) return res.status(409).json({ error: "That post already has a linked task." });
      }
      push("post_id", d.postId ?? null);
      // A post-linked task always reads as Content from here on, same as an auto-created one.
      push("task_type", "content");
    }

    if (d.taskType !== undefined && d.postId === undefined) {
      // Auto-created tasks are always "content" and that's not user-editable.
      // (Linking a post above already forces task_type — skip this branch then.)
      if (prior.post_id) {
        return res.status(400).json({ error: "This task's type is set automatically — it's linked to a post." });
      }
      push("task_type", d.taskType);
    }
    if (d.contentFormat !== undefined) push("content_format", d.contentFormat ?? null);

    // Reassigning — resets acceptance unless it's a no-op (same editor) or a
    // self-assign (claiming, or a manager assigning their own work to themselves).
    let accepted = prior.accepted;
    if (d.editorId !== undefined) {
      const nextEditorId = d.editorId ?? null;
      push("editor_id", nextEditorId);
      if (nextEditorId !== prior.editor_id) {
        accepted = !nextEditorId || (await callerEditorId(req)) === nextEditorId;
        push("accepted", accepted);
      }
    }
    // Format or assignee changed → re-snapshot the budget from current rules.
    // Only actually starts the countdown (budget_started_at) once accepted —
    // an unaccepted reassignment still shows the resolved hours, just paused.
    if (d.contentFormat !== undefined || d.editorId !== undefined) {
      const effectiveEditorId = d.editorId !== undefined ? (d.editorId ?? null) : prior.editor_id;
      const effectiveFormat = d.contentFormat !== undefined ? (d.contentFormat ?? null) : prior.content_format;
      const budgetHours = await resolveBudgetHours(req.orgId, effectiveEditorId, effectiveFormat);
      push("budget_hours", budgetHours);
      push("budget_started_at", budgetHours !== null && accepted ? new Date() : null);
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

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

// Accept an assignment — only the assignee themselves, and only once. This is
// what actually starts the time-budget countdown (budget_started_at); until
// this, an assigned-by-someone-else task just sits pending with no timer.
// startAt lets the client defer the start (e.g. "9am tomorrow" when accepting
// now would run the budget past office close) — client computes the wall-clock
// time since office hours are a local-time concept, not something the server
// should guess at.
tasksRouter.post("/tasks/:id/accept", requireEditor, async (req, res, next) => {
  const startAt = req.body?.startAt ? new Date(req.body.startAt) : new Date();
  if (isNaN(startAt.getTime())) return res.status(400).json({ error: "Invalid start time." });
  try {
    const prior = (await pool.query(
      "select editor_id, accepted, budget_hours from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!prior) return res.status(404).json({ error: "Task not found" });
    if (prior.accepted) return res.status(400).json({ error: "This task is already accepted." });
    const myEditorId = await callerEditorId(req);
    if (!myEditorId || myEditorId !== prior.editor_id) {
      return res.status(403).json({ error: "Only the person this task is assigned to can accept it." });
    }
    await pool.query(
      "update task set accepted = true, budget_started_at = $3 where id = $1 and org_id = $2",
      [req.params.id, req.orgId, prior.budget_hours != null ? startAt : null],
    );
    const { rows: full } = await pool.query(`${SELECT} where t.id = $1`, [req.params.id]);
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
      "select org_id, editor_id, channel_id, title, description, priority, due_date, task_type, content_format from task where id = $1",
      [taskId],
    )).rows[0];
    if (!t) return;
    const days = recurrence === "weekly" ? 7 : 1;
    // Advance from the current due date if set, else from today.
    const nextDue = `(coalesce($7::date, current_date) + interval '${days} day')::date`;
    // Fresh occurrence gets its own budget snapshot, resolved against
    // whatever rules apply right now (not copied from the completed one).
    const budgetHours = await resolveBudgetHours(t.org_id, t.editor_id, t.content_format);
    const { rows } = await pool.query(
      `insert into task (org_id, editor_id, channel_id, title, description, priority, due_date, recurrence, status, task_type, content_format, budget_hours, budget_started_at)
       values ($1,$2,$3,$4,$5,$6, ${nextDue}, $8, 'todo', $9, $10, $11, case when $11 is not null then now() else null end) returning id`,
      [t.org_id, t.editor_id, t.channel_id, t.title, t.description, t.priority, t.due_date, recurrence, t.task_type, t.content_format, budgetHours],
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
