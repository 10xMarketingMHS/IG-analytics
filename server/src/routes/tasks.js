import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { hasActiveGrant } from "../permissions.js";
import { logActivity } from "../activity.js";

export const tasksRouter = Router();

// Review is a checkpoint, not just another column: the assignee moves a task
// through todo -> in_progress -> review on their own, but only an admin can
// resolve a review — approve it into done, or send it back to in_progress
// for rework. See the status-transition guard in the PATCH handler below.
const STATUS = ["todo", "in_progress", "review", "done"];
const PRIORITY = ["low", "medium", "high"];
// What *kind* of task this is — separate from priority (how urgent). Auto-
// created (post-linked) tasks are always "content" and that's not user-editable.
// "emergency" was dropped — priority=high already covers urgency. "social"
// and "ad" each carry a secondary id alongside the task's own TID — see
// nextTaskRef() below.
const TASK_TYPE = ["content", "short_task", "general", "social", "ad", "admin", "service"];
const PLATFORMS = ["instagram", "facebook", "youtube"];

// Type-specific extras for social/ad tasks — small and varying enough per
// type that a JSON bag beats a wide sparse column set. All optional; nothing
// here is validated against a fixed platform list since it's just metadata,
// not a relation.
const MetaSchema = z
  .object({
    platform: z.string().max(40).optional(),
    caption: z.string().max(2000).optional(),
    assetLinks: z.string().max(2000).optional(),
    adSpend: z.number().nonnegative().optional(),
    targetUrl: z.string().max(500).optional(),
  })
  .partial();

const TaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  editorId: z.string().uuid().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
  postId: z.string().uuid().nullable().optional(),
  dueDate: z.string().optional().nullable(), // YYYY-MM-DD
  status: z.enum(STATUS).optional(),
  // Required when sending a task back from review to in_progress — what
  // needs fixing, so the team isn't just told "no" with nothing to act on.
  reviewNote: z.string().trim().max(2000).optional(),
  priority: z.enum(PRIORITY).optional(),
  recurrence: z.enum(["none", "daily", "weekly"]).optional(),
  taskType: z.enum(TASK_TYPE).optional(),
  // What production format the work is — an FK into the org's own
  // admin-manageable task_content_format list. Optional — not every task
  // (e.g. a short/general task) has one.
  contentFormatId: z.string().uuid().nullable().optional(),
  meta: MetaSchema.optional(),
  // When a save results in an accepted task with a resolvable time budget,
  // the client already knows (from this same response, checked after a first
  // save) whether the budget clock would run past office close — self-assign
  // never goes through the explicit /accept endpoint, so this is how it gets
  // the same "start now or 9 AM tomorrow" choice. Ignored for anything else.
  startAt: z.string().datetime().optional(),
  // Phase 1 additions. content_type is a flexible tag (UI drives the list).
  contentType: z.string().max(40).nullable().optional(),
  platforms: z.array(z.enum(PLATFORMS)).optional(),
  attachments: z.array(z.object({ url: z.string().url(), label: z.string().max(120).optional() })).optional(),
  // Admin Hold / Resume — parks an in-progress task and pauses its timer.
  onHold: z.boolean().optional(),
});

// Every task gets an org-wide TID as an internal key (no longer shown in the
// UI). A Social task additionally gets a per-BRAND SID, a Paid Ad task a
// per-brand AID — see nextBrandTaskRef. Either id searches straight to its
// parent task (see GET /tasks' q filter).
export async function nextTaskRef(orgId, kind) {
  const prefix = { tid: "TID", sid: "SID", adid: "AID" }[kind];
  const { rows } = await pool.query("select next_task_ref($1, $2) as n", [orgId, kind]);
  return `${prefix}-${String(rows[0].n).padStart(5, "0")}`;
}

// Per-brand (workspace) SID / AID — the numbering resets per brand, so each
// brand carries its own SID-00001…/AID-00001… sequence. Mirrors nextTaskRef
// but keyed by channel_id via next_brand_task_ref().
export async function nextBrandTaskRef(channelId, kind) {
  const prefix = { sid: "SID", adid: "AID", svid: "SVID" }[kind];
  const { rows } = await pool.query("select next_brand_task_ref($1, $2) as n", [channelId, kind]);
  return `${prefix}-${String(rows[0].n).padStart(5, "0")}`;
}

// Returned shape: task fields + assignee name/image + channel name for the UI.
// Content format is a joined name/icon (from the org's own taxonomy), not a
// fixed enum. Social Media tasks (post_id set) also carry the post's title,
// permalink and platform (account context) — a manual task has none of that,
// all null.
const SELECT = `
  select t.id, t.serial, t.title, t.description, t.editor_id, t.channel_id, t.post_id,
         t.status, t.priority, t.due_date, t.recurrence, t.task_type,
         t.tid, t.sid, t.ad_id, t.svid, t.meta, t.revision, t.pending_note,
         t.content_format_id, cf.name as content_format_name, cf.icon as content_format_icon,
         cf.points as content_format_points,
         t.budget_hours, t.budget_started_at, t.accepted, t.on_hold, t.held_by, t.created_at, t.completed_at,
         t.content_type, t.platforms, t.attachments,
         e.name as editor_name, e.image_url as editor_image,
         coalesce(hu.name, hu.email) as held_by_name,
         -- The assignee's break, so the client can offset the countdown by
         -- however long they've been (or are currently) on break — a break
         -- pauses every one of their running timers at once, computed here
         -- rather than by rewriting budget_started_at on each task.
         case when e.break_date = current_date then e.break_started_at end as editor_break_started_at,
         case when e.break_date = current_date then e.break_used_seconds else 0 end as editor_break_used_seconds,
         w.name as channel_name,
         p.title as post_title, p.permalink as post_permalink,
         pl.key as platform_key, pl.name as platform_name,
         (select count(*)::int from subtask s where s.task_id = t.id) as subtask_total,
         (select count(*)::int from subtask s where s.task_id = t.id and s.done) as subtask_done
    from task t
    left join editor e on e.id = t.editor_id
    left join workspace w on w.id = t.channel_id
    left join post p on p.id = t.post_id
    left join platform pl on pl.id = p.platform_id
    left join task_content_format cf on cf.id = t.content_format_id
    left join app_user hu on hu.id = t.held_by`;

// Time-budget resolution (Phase 1): an editor's own rule for a format wins,
// else the org-wide default, else no budget (task just has no timer).
// Exported — posts.js's syncPostTask needs it to give auto-created (post-linked)
// tasks a timer too, the same way a manually-created task gets one.
export async function resolveBudgetHours(orgId, editorId, contentFormatId) {
  if (!contentFormatId) return null;
  const { rows } = await pool.query(
    `select hours from task_time_rule
      where org_id = $1 and content_format_id = $2 and editor_id = $3
      union all
      select hours from task_time_rule
      where org_id = $1 and content_format_id = $2 and editor_id is null
      limit 1`,
    [orgId, contentFormatId, editorId],
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
    if (req.query.contentFormatId) {
      params.push(req.query.contentFormatId);
      clauses.push(`t.content_format_id = $${params.length}::uuid`);
    }
    if (req.query.dueBefore) {
      params.push(req.query.dueBefore);
      clauses.push(`t.due_date <= $${params.length}`);
    }
    if (req.query.dueAfter) {
      params.push(req.query.dueAfter);
      clauses.push(`t.due_date >= $${params.length}`);
    }
    // Global lookup by reference id (TID/SID/AdID) or a plain title match —
    // exact id hits are what the search bar is really for, title is a bonus.
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      clauses.push(`(t.tid ilike $${params.length} or t.sid ilike $${params.length} or t.ad_id ilike $${params.length} or t.svid ilike $${params.length} or t.title ilike $${params.length})`);
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
    // This endpoint is for manual tasks only (auto-created ones are inserted
    // directly by syncPostTask) — default to "general".
    const taskType = d.taskType ?? "general";
    // "admin" is an admin-only, lightweight personal category: no project, no
    // content format, no timer, self-assigned to the creating admin, and it
    // starts In Progress (the one deviation from "new tasks start in To Do").
    const isAdminTask = taskType === "admin";
    if (isAdminTask && req.role !== "admin") {
      return res.status(403).json({ error: "Only an admin can create an Admin task." });
    }
    const callerEid = await callerEditorId(req);
    const assigneeId = isAdminTask ? callerEid : (d.editorId ?? null);
    const status = isAdminTask ? "in_progress" : (d.status ?? "todo");
    const contentFormatId = isAdminTask ? null : (d.contentFormatId ?? null);
    // Admin tasks may optionally belong to a brand (Project) — they just never
    // get a content type, SID/AID or timer.
    const channelId = d.channelId ?? null;
    // Social / Ads / Service tasks are numbered per brand, so they must belong
    // to one (a Project) — enforce it up front rather than minting an orphan id.
    if ((taskType === "social" || taskType === "ad" || taskType === "service") && !channelId) {
      return res.status(400).json({ error: "Pick a Project (brand) — Social, Ads and Service tasks are numbered per brand." });
    }
    // Assigning to yourself accepts immediately — no separate approval needed
    // — but that's still an "accept" moment: the office-hours check just runs
    // client-side after this response instead of before it (see startAt).
    // Assigning to someone else needs their explicit accept before anything
    // starts (POST /tasks/:id/accept). Admin tasks are always self-assigned, so
    // always accepted, and have no timer to gate anyway.
    const accepted = !assigneeId || callerEid === assigneeId;
    // Admin tasks carry no time tracking at all — skip the budget lookup.
    const budgetHours = isAdminTask ? null : await resolveBudgetHours(req.orgId, assigneeId, contentFormatId);
    const hasBudget = accepted && budgetHours != null;
    const budgetStartedAt = hasBudget ? (d.startAt ? new Date(d.startAt) : new Date()) : null;
    // Every task gets an org-wide TID (internal key); a Social task also gets a
    // per-brand SID, a Paid Ad task a per-brand AID, a Service task a per-brand
    // SVID. Admin tasks get a TID only.
    const tid = await nextTaskRef(req.orgId, "tid");
    const sid = taskType === "social" ? await nextBrandTaskRef(channelId, "sid") : null;
    const adId = taskType === "ad" ? await nextBrandTaskRef(channelId, "adid") : null;
    const svid = taskType === "service" ? await nextBrandTaskRef(channelId, "svid") : null;
    // Atomically claim the next per-org Task ID (serial, "TASK-####") and
    // insert in one statement, alongside the TID/SID/AdID system above —
    // both id schemes point at the same row.
    const { rows } = await pool.query(
      `with s as (update org set task_seq = task_seq + 1 where id = $1 returning task_seq)
       insert into task (org_id, editor_id, channel_id, title, description,
                         status, priority, due_date, recurrence, task_type, content_format_id,
                         budget_hours, accepted, budget_started_at, completed_at,
                         tid, sid, ad_id, svid, meta, content_type, platforms, attachments, serial)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
              case when $6 = 'done' then now() else null end,
              $15,$16,$17,$18,$19,$20,$21,$22::jsonb, (select task_seq from s)
       returning id`,
      [
        req.orgId,
        assigneeId,
        channelId,
        d.title,
        d.description ?? "",
        status,
        d.priority ?? "medium",
        d.dueDate || null,
        d.recurrence ?? "none",
        taskType,
        contentFormatId,
        budgetHours,
        accepted,
        budgetStartedAt,
        tid,
        sid,
        adId,
        svid,
        JSON.stringify(d.meta ?? {}),
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
  // Note: d.status is NOT pushed here — it goes through the review-stage
  // permission gate + completed_at stamping further down (after `prior` is
  // fetched), not this generic field loop. See the sets.length guard below
  // that one instead of duplicating it here.
  try {
    // Capture prior state so we can spawn the next occurrence on completion,
    // guard task_type for post-linked tasks, and re-resolve the time budget.
    const prior = (await pool.query(
      "select status, recurrence, post_id, editor_id, channel_id, content_format_id, accepted, budget_hours, budget_started_at, budget_used_seconds, on_hold, sid, ad_id, svid, revision from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!prior) return res.status(404).json({ error: "Task not found" });

    // Status moves follow who's allowed to make that particular call:
    //  - todo/in_progress/review: only the assignee — not whoever assigned
    //    it, not an admin. Keeps "who's actually doing this" honest.
    //  - out of review (approve into done, or send back to in_progress for
    //    rework): only an admin — that's the whole point of a review stage.
    //  - into done from anywhere else: not allowed — it has to go through
    //    review first.
    // Only gate (and only touch the column) when this is an actual change —
    // the client always sends the current status alongside unrelated edits
    // (e.g. tweaking the description of a task sitting in review), and that
    // must never require admin rights just because status came along for the ride.
    // reviewLogAction/reviewNote, once set, drive the task_review_log entry
    // written after the main update below.
    let reviewLogAction = null;
    let reviewNote = null;
    if (d.status !== undefined && d.status !== prior.status) {
      if (prior.status === "review") {
        // Resolving a review (approve into done, or send back for rework) is an
        // admin power — or a resolve_tasks grantee acting with the same reach.
        if (req.role !== "admin" && !(await hasActiveGrant(req.orgId, req.user.sub, "resolve_tasks"))) {
          return res.status(403).json({ error: "Only an admin can approve or send back a task in review." });
        }
        if (d.status !== "done" && d.status !== "in_progress") {
          return res.status(400).json({ error: "From review, a task can only move to Completed or back to In progress." });
        }
        if (d.status === "in_progress") {
          reviewNote = (d.reviewNote ?? "").trim();
          if (!reviewNote) {
            return res.status(400).json({ error: "Add a note explaining what needs fixing before sending it back." });
          }
          reviewLogAction = "sent_back";
          // A rework cycle — bump the version so the team can tell revisions
          // apart, and require the assignee to explicitly re-accept before
          // the clock resumes (same gate a fresh assignment gets) — this is
          // also where the note actually reaches them, right at accept time.
          push("revision", prior.revision + 1);
          push("accepted", false);
          push("pending_note", reviewNote);
        } else {
          reviewLogAction = "approved";
          reviewNote = (d.reviewNote ?? "").trim() || null;
        }
      } else {
        if (d.status === "done") {
          return res.status(400).json({ error: "Move it to Review first — only an admin can mark it Completed." });
        }
        // Once work has started there's no going back to To Do — an admin parks
        // it with Hold instead. To Do is only the pre-start state.
        if (prior.status === "in_progress" && d.status === "todo") {
          return res.status(403).json({ error: "Once work has started, a task can't go back to To Do — an admin can put it on Hold instead." });
        }
        // A held task is frozen until an admin resumes it (clears the hold).
        if (prior.on_hold && req.role !== "admin") {
          return res.status(403).json({ error: "This task is on hold — an admin needs to resume it first." });
        }
        const myEditorId = await callerEditorId(req);
        if (!prior.editor_id || myEditorId !== prior.editor_id) {
          return res.status(403).json({ error: "Only the person this task is assigned to can change its status." });
        }
      }
      // Entering review pauses the clock — bank whatever's elapsed so far
      // rather than letting review time (or a later rework cycle) eat into
      // the assignee's actual working budget; resumes exactly where it left
      // off when they're accepted back in (see POST /tasks/:id/accept).
      if (d.status === "review" && prior.budget_started_at && prior.budget_hours != null) {
        const elapsedSec = Math.max(0, (Date.now() - new Date(prior.budget_started_at).getTime()) / 1000);
        push("budget_used_seconds", Number(prior.budget_used_seconds ?? 0) + elapsedSec);
        push("budget_started_at", null);
      }
      push("status", d.status);
      // Stamp/clear completion time as status moves in/out of "done".
      sets.push(`completed_at = case when $${params.length} = 'done' then coalesce(completed_at, now()) else null end`);
    }

    // Hold / Resume — parks an in-progress task (it stays In Progress, just
    // flagged) and pauses its time-budget countdown; resuming picks the clock
    // back up from where it left off. Self-service: an admin OR the task's own
    // assignee can do either. This is symmetric — release permission does NOT
    // depend on who applied the hold (held_by is informational only), so an
    // admin can resume an assignee's hold and vice-versa. Mirrors the exact
    // assignee identity check the forward-status-move gate uses above. A
    // hold_tasks grantee gets admin-like reach — hold/resume ANY task.
    if (d.onHold !== undefined && d.onHold !== prior.on_hold) {
      if (req.role !== "admin" && !(await hasActiveGrant(req.orgId, req.user.sub, "hold_tasks"))) {
        const myEditorId = await callerEditorId(req);
        if (!prior.editor_id || myEditorId !== prior.editor_id) {
          return res.status(403).json({ error: "Only an admin or the task's assignee can put it on hold or resume it." });
        }
      }
      if (d.onHold) {
        // Pause: bank whatever's elapsed and stop the clock (mirrors Review).
        if (prior.budget_started_at && prior.budget_hours != null) {
          const elapsedSec = Math.max(0, (Date.now() - new Date(prior.budget_started_at).getTime()) / 1000);
          push("budget_used_seconds", Number(prior.budget_used_seconds ?? 0) + elapsedSec);
          push("budget_started_at", null);
        }
        push("on_hold", true);
        // Record who applied this hold — informational, for the badge.
        push("held_by", req.user.sub);
      } else {
        // Resume: restart the countdown from what was banked (mirrors accept).
        if (prior.budget_hours != null) {
          const usedSec = Number(prior.budget_used_seconds ?? 0);
          push("budget_started_at", new Date(Date.now() - usedSec * 1000));
          push("budget_used_seconds", 0);
        }
        push("on_hold", false);
      }
    }

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
      // Retroactively mint the per-brand secondary id the moment a task becomes
      // Social or Paid Ad — numbered within its brand (Project), so it needs
      // one. Uses the channel being set in this same PATCH if present, else the
      // task's existing one. Never re-generates an id that already exists.
      if (d.taskType === "social" || d.taskType === "ad" || d.taskType === "service") {
        const effChannel = d.channelId !== undefined ? (d.channelId ?? null) : prior.channel_id;
        if (!effChannel) {
          return res.status(400).json({ error: "Pick a Project (brand) first — Social, Ads and Service tasks are numbered per brand." });
        }
        if (d.taskType === "social" && !prior.sid) push("sid", await nextBrandTaskRef(effChannel, "sid"));
        if (d.taskType === "ad" && !prior.ad_id) push("ad_id", await nextBrandTaskRef(effChannel, "adid"));
        if (d.taskType === "service" && !prior.svid) push("svid", await nextBrandTaskRef(effChannel, "svid"));
      }
    }
    if (d.contentFormatId !== undefined) push("content_format_id", d.contentFormatId ?? null);
    if (d.meta !== undefined) push("meta", JSON.stringify(d.meta));

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
    // startAt lets the caller pick when the clock starts (e.g. self-assigning
    // past office close, same "start now or 9 AM tomorrow" choice the explicit
    // accept endpoint offers) — defaults to now, same as before.
    if (d.contentFormatId !== undefined || d.editorId !== undefined) {
      const effectiveEditorId = d.editorId !== undefined ? (d.editorId ?? null) : prior.editor_id;
      const effectiveFormatId = d.contentFormatId !== undefined ? (d.contentFormatId ?? null) : prior.content_format_id;
      const budgetHours = await resolveBudgetHours(req.orgId, effectiveEditorId, effectiveFormatId);
      push("budget_hours", budgetHours);
      push("budget_started_at", budgetHours !== null && accepted ? (d.startAt ? new Date(d.startAt) : new Date()) : null);
      // Handing it to someone new — any time banked from the previous
      // assignee's paused work session doesn't carry over to them.
      if (d.editorId !== undefined && d.editorId !== prior.editor_id) push("budget_used_seconds", 0);
    } else if (d.startAt !== undefined && prior.accepted && prior.budget_hours != null) {
      // Pure reschedule — nothing else about the task changed, just when its
      // already-running clock should count from (e.g. deferring a self-assign
      // made after office hours to 9 AM tomorrow instead).
      push("budget_started_at", new Date(d.startAt));
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
    // Record the review decision (and, for a rework cycle, the note the team
    // needs) against the revision it just landed on.
    if (reviewLogAction) {
      await pool.query(
        `insert into task_review_log (task_id, revision, action, note, actor_id) values ($1, $2, $3, $4, $5)`,
        [req.params.id, full[0].revision, reviewLogAction, reviewNote, req.user.sub],
      );
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
      "select editor_id, accepted, budget_hours, status, budget_used_seconds from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!prior) return res.status(404).json({ error: "Task not found" });
    if (prior.accepted) return res.status(400).json({ error: "This task is already accepted." });
    const myEditorId = await callerEditorId(req);
    if (!myEditorId || myEditorId !== prior.editor_id) {
      return res.status(403).json({ error: "Only the person this task is assigned to can accept it." });
    }
    // Resuming after a pause (sent back from review) picks up where it left
    // off — the start point shifts back by however much was already banked,
    // so the countdown reflects only what's actually left, not a fresh
    // budget_hours. A brand-new assignment has nothing banked, so this is a
    // no-op for the normal case.
    const usedSec = Number(prior.budget_used_seconds ?? 0);
    const effectiveStart = usedSec > 0 ? new Date(startAt.getTime() - usedSec * 1000) : startAt;
    // Accepting a task still sitting in To Do is also what actually starts
    // work on it — move it into In Progress in the same step, instead of
    // requiring a separate manual drag right after.
    const nextStatus = prior.status === "todo" ? "in_progress" : prior.status;
    await pool.query(
      `update task
          set accepted = true, budget_started_at = $3, budget_used_seconds = 0, pending_note = null, status = $4
        where id = $1 and org_id = $2`,
      [req.params.id, req.orgId, prior.budget_hours != null ? effectiveStart : null, nextStatus],
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
      "select org_id, editor_id, channel_id, title, description, priority, due_date, task_type, content_format_id from task where id = $1",
      [taskId],
    )).rows[0];
    if (!t) return;
    const days = recurrence === "weekly" ? 7 : 1;
    // Advance from the current due date if set, else from today.
    const nextDue = `(coalesce($7::date, current_date) + interval '${days} day')::date`;
    // Fresh occurrence gets its own budget snapshot, resolved against
    // whatever rules apply right now (not copied from the completed one) —
    // and its own TID, being a distinct row (a recurring Social/Ad task also
    // gets a fresh SID/AdID, same as any other task of that type).
    const budgetHours = await resolveBudgetHours(t.org_id, t.editor_id, t.content_format_id);
    const tid = await nextTaskRef(t.org_id, "tid");
    const sid = t.task_type === "social" && t.channel_id ? await nextBrandTaskRef(t.channel_id, "sid") : null;
    const adId = t.task_type === "ad" && t.channel_id ? await nextBrandTaskRef(t.channel_id, "adid") : null;
    const svid = t.task_type === "service" && t.channel_id ? await nextBrandTaskRef(t.channel_id, "svid") : null;
    const { rows } = await pool.query(
      `insert into task (org_id, editor_id, channel_id, title, description, priority, due_date, recurrence, status, task_type, content_format_id, budget_hours, budget_started_at, tid, sid, ad_id, svid)
       values ($1,$2,$3,$4,$5,$6, ${nextDue}, $8, 'todo', $9, $10, $11, case when $11::numeric is not null then now() else null end, $12, $13, $14, $15) returning id`,
      [t.org_id, t.editor_id, t.channel_id, t.title, t.description, t.priority, t.due_date, recurrence, t.task_type, t.content_format_id, budgetHours, tid, sid, adId, svid],
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

// Every review decision on this task — sent back (with its note) or
// approved — newest first, so the team can see exactly what changed each
// revision and why.
tasksRouter.get("/tasks/:id/reviews", async (req, res, next) => {
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    const { rows } = await pool.query(
      `select l.id, l.revision, l.action, l.note, l.created_at,
              coalesce(u.name, u.email) as actor_name
         from task_review_log l
         left join app_user u on u.id = l.actor_id
        where l.task_id = $1
        order by l.created_at desc`,
      [req.params.id],
    );
    res.json({ reviews: rows });
  } catch (err) {
    next(err);
  }
});

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
