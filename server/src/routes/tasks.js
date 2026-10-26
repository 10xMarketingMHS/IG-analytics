import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { requireActiveEod } from "./eod.js";
import { assignLimits, hasActiveGrant } from "../permissions.js";
import { callerAccess } from "../page-access.js";
import { reviewContext, routeReview, withReview } from "../review-route.js";
import { logActivity } from "../activity.js";
import { canSeeTask, editorRanks, mayOpenTask, seesEditor, taskViewer } from "../hierarchy.js";
import { closePendingHandovers } from "../handover.js";
import { hasColumn } from "../schema-flags.js";
import { coverFrom } from "../goal-score.js";
import { enterScheduling, leaveScheduling, schedulerIds, schedulingReady } from "../scheduling.js";
import { adTeamsReady, enterUploads, leaveUploads, nextTeamAid, uploadsReady } from "../ad-uploads.js";

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
const TASK_TYPE = ["content", "short_task", "general", "social", "ad", "admin", "service", "project"];

// Date-only helpers for Project start/due bounds. YYYY-MM-DD strings compare
// lexicographically, so range checks need no Date math; addDaysYmd shifts a
// calendar date in UTC (no DST for date-only values). "Today" is IST, matching
// the rest of the app's calendar handling.
function todayYmdIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
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
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  editorId: z.string().uuid().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
  postId: z.string().uuid().nullable().optional(),
  dueDate: z.string().optional().nullable(), // YYYY-MM-DD
  startDate: z.string().optional().nullable(), // YYYY-MM-DD — Project start
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
  // Ads: the team it's made for (Settings › Tasks & time › Ads teams), which
  // numbers it (AID per team) instead of a brand.
  adTeamId: z.string().uuid().nullable().optional(),
  // Per-task "delivery link required to submit for review". null = follow the
  // content type's default. Only an admin / assign_tasks grantee may set it.
  reviewLinkRequired: z.boolean().nullable().optional(),
  // Approving a task that needs a delivery link but has none is refused unless
  // the reviewer explicitly confirms it (the app asks first).
  approveWithoutWork: z.boolean().optional(),
  meta: MetaSchema.optional(),
  // Other work (../goal-score.js): which team asked for a task given to someone
  // (kept in meta.requestedBy), and how long it should take — its time budget,
  // which caps the time it takes off that person's goal when it's outside them.
  requestedBy: z.string().trim().max(80).nullable().optional(),
  budgetHours: z.number().min(0.25, "Should take: at least 15 minutes.").max(200, "Should take: 200 hours at most.").nullable().optional(),
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
  // Delivery Link — URL to the completed deliverable. Same http/https URL
  // validation Posts' link uses; "" or null clears it. Not for admin tasks.
  deliveryLink: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
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
  const prefix = { sid: "SID", adid: "AID", svid: "SVID", pid: "PID" }[kind];
  const { rows } = await pool.query("select next_brand_task_ref($1, $2) as n", [channelId, kind]);
  return `${prefix}-${String(rows[0].n).padStart(5, "0")}`;
}

// An Ad task's AID: the next in its team (with none, its brand), passing over
// any number a task of that team or brand already holds — an ad moved in from
// another team, or one that keeps an older brand, may hold it already.
async function nextFreeAid(teamId, channelId) {
  const teams = await adTeamsReady();
  for (;;) {
    const aid = teamId ? await nextTeamAid(teamId) : await nextBrandTaskRef(channelId, "adid");
    const { rowCount } = await pool.query(
      `select 1 from task where ad_id = $1 and (${teams ? "ad_team_id = $2 or " : ""}channel_id = $3) limit 1`,
      teams ? [aid, teamId ?? null, channelId ?? null] : [aid, null, channelId ?? null],
    );
    if (!rowCount) return aid;
  }
}
const activeTeam = async (id, orgId) =>
  (await adTeamsReady()) && (await pool.query("select 1 from ad_team where id = $1 and org_id = $2 and active", [id, orgId])).rowCount > 0;

// Returned shape: task fields + assignee name/image + channel name for the UI.
// Content format is a joined name/icon (from the org's own taxonomy), not a
// fixed enum. Social Media tasks (post_id set) also carry the post's title,
// permalink and platform (account context) — a manual task has none of that,
// all null.
const SELECT = `
  select t.id, t.serial, t.title, t.description, t.editor_id, t.channel_id, t.post_id,
         t.status, t.priority, t.due_date, t.recurrence, t.task_type,
         t.tid, t.sid, t.ad_id, t.svid, t.pid, t.start_date, t.meta, t.revision, t.pending_note,
         t.content_format_id, cf.name as content_format_name, cf.icon as content_format_icon,
         -- a completed task keeps the points it earned (points_at_done, see
         -- 20261027120000_frozen_points.sql); open ones show the type's points now
         case when t.status = 'done' then coalesce((to_jsonb(t)->>'points_at_done')::numeric, cf.points) else cf.points end as content_format_points, cf.duration_days as content_format_duration,
         cf.metrics_description as content_format_metrics,
         cf.review_link_required as content_format_link_required,
         coalesce(t.review_link_required, cf.review_link_required, false) as link_required,
         t.budget_hours, t.budget_started_at, t.budget_used_seconds, t.accepted, t.on_hold, t.held_by, t.created_at, t.completed_at, t.created_by, t.assigned_by,
         -- Time spent waiting for a reviewer, taken off lateness when scoring.
         t.review_started_at, t.review_wait_seconds::float as review_wait_seconds,
         -- The assignee made this task for themselves (marked in the UI, so
         -- reviewers and My Team can tell it from assigned work).
         (t.created_by is not null and exists (
            select 1 from app_user cu where cu.id = t.created_by and cu.editor_id = t.editor_id)) as self_created,
         t.content_type, t.platforms, t.attachments, t.delivery_link,
         -- Scheduling after approval (../scheduling.js), read through to_jsonb so
         -- it works before 20261104120000_task_scheduling; linked_posts: taskSelect()
         (to_jsonb(t)->>'scheduler_id')::uuid as scheduler_id, (to_jsonb(t)->>'schedule_from')::timestamptz as schedule_from,
         to_jsonb(t)->>'post_on' as post_on, left(to_jsonb(t)->>'post_time', 5) as post_time, se.name as scheduler_name,
         /*linked_posts*/0 as linked_posts,
         -- Ad uploads after approval (../ad-uploads.js), the same way: ad_count: taskSelect()
         (to_jsonb(t)->>'upload_from')::timestamptz as upload_from, /*ad_count*/0 as ad_count,
         (to_jsonb(t)->>'ad_team_id')::uuid as ad_team_id, /*ad_team_name*/null::text as ad_team_name,
         e.name as editor_name, e.image_url as editor_image,
         coalesce(hu.name, hu.email) as held_by_name,
         -- The assignee's break, so the client can offset the countdown by
         -- however long they've been (or are currently) on break — a break
         -- pauses every one of their running timers at once, computed here
         -- rather than by rewriting budget_started_at on each task.
         case when e.break_date = (now() at time zone 'Asia/Kolkata')::date then e.break_started_at end as editor_break_started_at,
         case when e.break_date = (now() at time zone 'Asia/Kolkata')::date then e.break_used_seconds else 0 end as editor_break_used_seconds,
         w.name as channel_name,
         p.title as post_title, p.permalink as post_permalink,
         pl.key as platform_key, pl.name as platform_name,
         (select count(*)::int from subtask s where s.task_id = t.id) as subtask_total,
         (select count(*)::int from subtask s where s.task_id = t.id and s.done) as subtask_done
    from task t
    left join editor e on e.id = t.editor_id
    left join editor se on se.id = (to_jsonb(t)->>'scheduler_id')::uuid
    left join workspace w on w.id = t.channel_id
    left join post p on p.id = t.post_id
    left join platform pl on pl.id = p.platform_id
    left join task_content_format cf on cf.id = t.content_format_id
    left join app_user hu on hu.id = t.held_by`;

// SELECT, with how many posts were made from each task's links (once the database has them).
export async function taskSelect() {
  let s = SELECT;
  if (await schedulingReady()) s = s.replace("/*linked_posts*/0", "(select count(*)::int from post fp where fp.from_task_id = t.id and fp.deleted_at is null)");
  if (await uploadsReady()) s = s.replace("/*ad_count*/0", "(select count(*)::int from task_ad ta where ta.task_id = t.id)");
  if (await adTeamsReady()) s = s.replace("/*ad_team_name*/null::text", "(select atm.name from ad_team atm where atm.id = t.ad_team_id)");
  return s;
}

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
export async function callerEditorId(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}

// Setting work up for other people — assigning it, re-planning it, removing it —
// is for an admin or an assign_tasks grantee (Settings → Access).
export async function canAssignTasks(req) {
  // Page access (../page-access.js): a saved row's Task Board Change stands in for the admin role
  const a = await callerAccess(req);
  if (a.super || (a.pages ? a.pages.tasks.change : req.role === "admin")) return true;
  return hasActiveGrant(req.orgId, req.user.sub, "assign_tasks");
}
// Someone else's task is in an assigner's hands only when they set it up: they
// assigned it, or they made it and it's still unassigned. Assign tasks doesn't
// reach work another person assigned.
export function setUpBy(task, userId) {
  return task.assigned_by === userId || (!task.editor_id && task.created_by === userId);
}
// Giving work to someone: never to a person above you (only the Super Admin
// sees, and assigns to, everyone). Null when fine, else what to say.
async function aboveYouError(req, editorId) {
  if (!editorId) return null;
  if (editorId === (await callerEditorId(req))) return null;
  const [viewer, ranks] = await Promise.all([taskViewer(req), editorRanks(req.orgId)]);
  return seesEditor(viewer, ranks, editorId) ? null : "You can't give work to someone above you.";
}

// An Assign tasks grant limited to some content types or some people
// (Settings › Access) covers only those tasks, given to those people. Null when
// it's allowed (or for admins), else what to tell them.
async function assignLimitError(req, contentFormatId, editorId) {
  if (req.role === "admin") return null;
  const lim = await assignLimits(req.orgId, req.user.sub);
  if (!lim) return null;
  if (lim.editors && !(editorId && lim.editors.includes(editorId))) {
    const { rows } = await pool.query("select name from editor where id = any($1::uuid[]) order by name", [lim.editors]);
    return `You can assign tasks only to ${rows.map((r) => r.name).join(", ") || "certain people"}.`;
  }
  if (lim.formats && !(contentFormatId && lim.formats.includes(contentFormatId))) {
    const { rows } = await pool.query("select name from task_content_format where id = any($1::uuid[]) order by name", [lim.formats]);
    return `You can assign only ${rows.map((r) => r.name).join(", ") || "certain content types"} tasks to other people.`;
  }
  return null;
}

// List every task in the org, newest-relevant first. Optional filters:
//   editorId=<uuid>   — a specific assignee
//   assignee=me        — tasks assigned to the caller's linked editor (§ My Tasks)
//   status=<status>
//   taskType=<type>
//   dueBefore/dueAfter — YYYY-MM-DD, inclusive, for due-date range views
//   socialMedia=1       — only post-linked tasks (§ Social Media tracking)
//   open=1              — not completed (what the alerts look at)
//   lite=1              — only the fields the alerts read (a much smaller answer)
// What the background alerts read (new task, over budget, overdue, review
// waiting) — polled every minute, so it carries nothing else.
const LITE = [
  "id", "title", "status", "editor_id", "editor_name", "due_date", "created_by", "accepted", "on_hold",
  "budget_hours", "budget_started_at", "budget_used_seconds", "editor_break_used_seconds", "editor_break_started_at",
  "review_started_at", "can_review", "review_by",
];
const liteTask = (t) => Object.fromEntries(LITE.filter((k) => k in t).map((k) => [k, t[k]]));
tasksRouter.get("/tasks", async (req, res, next) => {
  try {
    const clauses = ["t.org_id = $1"];
    const params = [req.orgId];
    if (req.query.socialMedia === "1") clauses.push("t.post_id is not null");
    if (req.query.open === "1") clauses.push("t.status <> 'done'");

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
    // Nobody sees the tasks of someone above them in the hierarchy (the Super
    // Admin sees all). The list, who's asking and everyone's rank are read together.
    const [{ rows }, viewer, ranks] = await Promise.all([
      pool.query(
        `${await taskSelect()} where ${clauses.join(" and ")}
         order by t.due_date asc nulls last, t.created_at desc`,
        params,
      ),
      taskViewer(req),
      editorRanks(req.orgId),
    ]);
    const seen = viewer.seesAll ? rows : rows.filter((t) => canSeeTask(viewer, ranks, t));
    const tasks = await withReview(req, seen);
    res.json({ tasks: req.query.lite === "1" ? tasks.map(liteTask) : tasks });
  } catch (err) {
    next(err);
  }
});

// Every id a task points at must be this organisation's — its brand, content
// type and person; another organisation's would show its names and take its
// points. Null when fine, else what to say.
async function outsideOrgError(orgId, d) {
  const checks = [
    [d.channelId, "select 1 from workspace where id = $1 and org_id = $2", "That brand wasn't found."],
    [d.contentFormatId, "select 1 from task_content_format where id = $1 and org_id = $2", "That content type wasn't found."],
    [d.editorId, "select 1 from editor where id = $1 and org_id = $2", "That team member wasn't found."],
  ];
  for (const [id, sql, msg] of checks) {
    if (!id) continue;
    const { rowCount } = await pool.query(sql, [id, orgId]);
    if (!rowCount) return msg;
  }
  return null;
}

tasksRouter.post("/tasks", requireEditor, requireActiveEod, async (req, res, next) => {
  const parsed = TaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const d = parsed.data;
  try {
    const outside = await outsideOrgError(req.orgId, d);
    if (outside) return res.status(400).json({ error: outside });
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
    if (isAdminTask && !callerEid) {
      return res.status(400).json({ error: "Add yourself to the team first (Settings → Team → Edit on your row) — an Admin task is assigned to you." });
    }
    if (!isAdminTask && d.editorId && d.editorId !== callerEid && !(await canAssignTasks(req))) {
      return res.status(403).json({ error: "You can create tasks for yourself. Assigning work to someone else needs an admin." });
    }
    if (!isAdminTask && d.editorId && d.editorId !== callerEid) {
      const limit = await assignLimitError(req, d.contentFormatId ?? null, d.editorId) ?? await aboveYouError(req, d.editorId);
      if (limit) return res.status(403).json({ error: limit });
    }
    const assigneeId = isAdminTask ? callerEid : (d.editorId ?? null);
    // Every new task starts in To Do — nothing is auto-started (not even admin
    // tasks, which used to open In Progress). A task moves to In Progress only
    // when the assignee clicks Start on the board (todo -> in_progress).
    const status = "todo";
    const contentFormatId = isAdminTask ? null : (d.contentFormatId ?? null);
    // Admin tasks may optionally belong to a brand (Project) — they just never
    // get a content type, SID/AID or timer.
    const channelId = d.channelId ?? null;
    // An Ad task is made for an Ads team and numbered within it (no brand needed).
    let adTeamId = null;
    if (taskType === "ad" && d.adTeamId) {
      const ok = (await adTeamsReady()) && (await pool.query("select 1 from ad_team where id = $1 and org_id = $2 and active", [d.adTeamId, req.orgId])).rowCount;
      if (!ok) return res.status(400).json({ error: "Pick the team this ad is for." });
      adTeamId = d.adTeamId;
    }
    // Social / Ads / Service / Project tasks are numbered per brand (Ads: per
    // team), so they must belong to one — enforce it up front rather than minting an orphan id.
    if (taskType === "ad" && !channelId && !adTeamId) {
      return res.status(400).json({ error: "Pick the team this ad is for — Ads are numbered per team." });
    }
    if ((taskType === "social" || taskType === "service" || taskType === "project") && !channelId) {
      return res.status(400).json({ error: "Pick a Brand — Social, Service and Project tasks are numbered per brand." });
    }
    // Project: has a Start Date (defaults to today) and a Due Date bounded by the
    // selected project type's configured duration. Enforced server-side, not just
    // in the date picker.
    const isProject = taskType === "project";
    let startDate = null;
    if (isProject) {
      startDate = d.startDate || todayYmdIst();
      const dur = contentFormatId
        ? (await pool.query("select duration_days from task_content_format where id = $1 and org_id = $2", [contentFormatId, req.orgId])).rows[0]?.duration_days ?? null
        : null;
      if (d.dueDate) {
        if (d.dueDate < startDate) return res.status(400).json({ error: "Due Date can't be before the Start Date." });
        if (dur != null && d.dueDate > addDaysYmd(startDate, dur)) {
          return res.status(400).json({ error: `Due Date must be within ${dur} day(s) of the Start Date.` });
        }
      }
    }
    // Assigning to yourself accepts immediately — no separate approval needed.
    // Assigning to someone else needs their explicit accept before anything
    // starts (POST /tasks/:id/accept). Admin tasks are always self-assigned, so
    // always accepted, and have no timer to gate anyway.
    const accepted = !assigneeId || callerEid === assigneeId;
    // Admin tasks carry no time tracking at all — skip the budget lookup. A
    // task given to someone else may come with the time it should take.
    const budgetHours = isAdminTask ? null
      : d.budgetHours != null && !accepted ? d.budgetHours
      : await resolveBudgetHours(req.orgId, assigneeId, contentFormatId);
    // The clock never starts at creation: an assigned task's starts on Accept,
    // one you made for yourself when you press Start (see PATCH). A morning plan
    // full of new tasks would otherwise start every timer at once.
    const budgetStartedAt = null;
    // Every task gets an org-wide TID (internal key); a Social task also gets a
    // per-brand SID, a Paid Ad task a per-brand AID, a Service task a per-brand
    // SVID. Admin tasks get a TID only.
    const tid = await nextTaskRef(req.orgId, "tid");
    const sid = taskType === "social" ? await nextBrandTaskRef(channelId, "sid") : null;
    const adId = taskType !== "ad" ? null : await nextFreeAid(adTeamId, channelId);
    const svid = taskType === "service" ? await nextBrandTaskRef(channelId, "svid") : null;
    const pid = isProject ? await nextBrandTaskRef(channelId, "pid") : null;
    // Atomically claim the next per-org Task ID (serial, "TASK-####") and
    // insert in one statement, alongside the TID/SID/AdID system above —
    // both id schemes point at the same row.
    const { rows } = await pool.query(
      `with s as (update org set task_seq = task_seq + 1 where id = $1 returning task_seq)
       insert into task (org_id, editor_id, channel_id, title, description,
                         status, priority, due_date, recurrence, task_type, content_format_id,
                         budget_hours, accepted, budget_started_at, completed_at,
                         tid, sid, ad_id, svid, pid, start_date, meta, content_type, platforms, attachments, serial)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
              case when $6 = 'done' then now() else null end,
              $15,$16,$17,$18,$23,$24,$19,$20,$21,$22::jsonb, (select task_seq from s)
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
        JSON.stringify({ ...(d.meta ?? {}), ...(d.requestedBy ? { requestedBy: d.requestedBy } : {}) }),
        d.contentType ?? null,
        d.platforms ?? [],
        JSON.stringify(d.attachments ?? []),
        pid,
        startDate,
      ],
    );
    // Handed to someone else → the creator is its assigner (who may review it).
    const creatorEid = await callerEditorId(req);
    const assignedBy = d.editorId && d.editorId !== creatorEid ? req.user.sub : null;
    await pool.query("update task set created_by = $2, assigned_by = $3 where id = $1", [rows[0].id, req.user.sub, assignedBy]);
    if (adTeamId) await pool.query("update task set ad_team_id = $2 where id = $1", [rows[0].id, adTeamId]);
    if (typeof d.reviewLinkRequired === "boolean" && (await canAssignTasks(req))) {
      await pool.query("update task set review_link_required = $2 where id = $1", [rows[0].id, d.reviewLinkRequired]);
    }
    const { rows: full } = await pool.query(`${await taskSelect()} where t.id = $1`, [rows[0].id]);
    await logActivity({
      orgId: req.orgId,
      actorId: req.user.sub,
      verb: "created",
      entityType: "task",
      entityId: full[0].id,
      channelId: full[0].channel_id,
      // who it's for, so the task's History starts with it
      summary: !full[0].editor_id ? `Created task “${full[0].title}”`
        : assignedBy ? `Created task “${full[0].title}” for ${full[0].editor_name ?? "a team member"}`
        : `Created task “${full[0].title}” for themselves`,
      meta: { toEditorId: full[0].editor_id ?? null },
    });
    res.status(201).json({ task: full[0] });
  } catch (err) {
    next(err);
  }
});

tasksRouter.patch("/tasks/:id", requireEditor, requireActiveEod, async (req, res, next) => {
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
  if (d.startDate !== undefined) push("start_date", d.startDate || null);
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
    const outside = await outsideOrgError(req.orgId, d);
    if (outside) return res.status(400).json({ error: outside });
    // Capture prior state so we can spawn the next occurrence on completion,
    // guard task_type for post-linked tasks, and re-resolve the time budget.
    const prior = (await pool.query(
      "select status, recurrence, post_id, editor_id, channel_id, content_format_id, accepted, budget_hours, budget_started_at, budget_used_seconds, on_hold, sid, ad_id, svid, pid, start_date, due_date, revision, task_type, delivery_link, review_link_required, title, description, priority, content_type, platforms, attachments, meta, created_by, held_by, assigned_by, review_started_at, to_jsonb(task)->>'covered_from_editor_id' as covered_from, (to_jsonb(task)->>'ad_team_id')::uuid as ad_team_id from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!prior) return res.status(404).json({ error: "Task not found" });

    // A task waiting for review, or completed, keeps its person — for everyone,
    // admins included. Moving it then (or approving and taking it in one go)
    // would hand the work, and its points, to whoever moved it, and make them
    // its reviewer. Send it back first; a completed task stays whose it was.
    if (d.editorId !== undefined && (d.editorId ?? null) !== prior.editor_id
        && (prior.status === "review" || prior.status === "done")) {
      return res.status(409).json({
        error: prior.status === "review"
          ? "A task waiting for review can't change hands. Send it back first, then reassign it."
          : "A completed task can't change hands.",
      });
    }

    // Who may change what (admins: anything):
    //  - a completed task is frozen as it was approved — work link included;
    //  - handing a task to someone is for assigners; anyone may take an
    //    unassigned one for themselves;
    //  - the brief (title, description, brand, type, dates, priority, repeat)
    //    belongs to whoever set the task up: an assigner, or the assignee when
    //    they created the task for themselves. The due date and content type in
    //    particular drive points and the review-link rule, so an assigned task's
    //    can't be moved by the person doing it;
    //  - the working fields (links, platforms, post) are the assignee's.
    // Values that arrive unchanged are fine — the edit forms resend them.
    if (req.role !== "admin") {
      const myEid = await callerEditorId(req);
      const assigner = await hasActiveGrant(req.orgId, req.user.sub, "assign_tasks");
      const own = !!myEid && prior.editor_id === myEid;
      const same = (a, b) => (a ?? null) === (b ?? null);
      const json = (v) => JSON.stringify(v ?? null);
      const briefChanged =
        (d.title !== undefined && d.title !== prior.title)
        || (d.requestedBy !== undefined && !same(d.requestedBy || null, prior.meta?.requestedBy ?? null))
        || (d.budgetHours !== undefined && !same(d.budgetHours == null ? null : Number(d.budgetHours), prior.budget_hours == null ? null : Number(prior.budget_hours)))
        || (d.description !== undefined && (d.description ?? "") !== (prior.description ?? ""))
        || (d.channelId !== undefined && !same(d.channelId, prior.channel_id))
        || (d.priority !== undefined && d.priority !== prior.priority)
        || (d.dueDate !== undefined && !same(d.dueDate || null, prior.due_date))
        || (d.startDate !== undefined && !same(d.startDate || null, prior.start_date))
        || (d.recurrence !== undefined && d.recurrence !== prior.recurrence)
        || (d.contentType !== undefined && !same(d.contentType, prior.content_type))
        || (d.taskType !== undefined && d.taskType !== prior.task_type)
        || (d.contentFormatId !== undefined && !same(d.contentFormatId, prior.content_format_id));
      const workChanged =
        (d.attachments !== undefined && json(d.attachments) !== json(prior.attachments ?? []))
        || (d.platforms !== undefined && json(d.platforms) !== json(prior.platforms ?? []))
        || (d.meta !== undefined && json(d.meta) !== json(prior.meta ?? {}))
        || (d.postId !== undefined && !same(d.postId, prior.post_id))
        || (d.deliveryLink !== undefined && !same(d.deliveryLink || null, prior.delivery_link))
        || d.startAt !== undefined;
      const assigneeChanged = d.editorId !== undefined && !same(d.editorId, prior.editor_id);
      const claiming = assigneeChanged && !prior.editor_id && !!myEid && d.editorId === myEid;
      if (prior.status === "done" && (briefChanged || workChanged || assigneeChanged)) {
        return res.status(403).json({ error: "This task is completed — only an admin can change it." });
      }
      if (assigneeChanged && !claiming && !assigner) {
        return res.status(403).json({ error: "Only an admin can reassign a task." });
      }
      // Moving work: an unassigned task, one you set up, or one you made for
      // yourself. A task someone else gave you goes on by Hand over instead.
      const mineMade = own && !prior.assigned_by && prior.created_by === req.user.sub;
      if (assigneeChanged && !claiming && prior.editor_id && !mineMade && !setUpBy(prior, req.user.sub)) {
        return res.status(403).json({ error: own
          ? "This task was given to you. To pass it on, use Hand over."
          : "You can move only tasks you assigned. Ask whoever assigned it, or an admin." });
      }
      // A limited Assign tasks grant (say Carousel only) covers only those
      // types on other people's tasks: handing one over, or changing its brief
      // or its type.
      const ownerAfter = d.editorId !== undefined ? (d.editorId ?? null) : prior.editor_id;
      if (ownerAfter && ownerAfter !== myEid && ((assigneeChanged && !claiming) || briefChanged)) {
        const limit = await assignLimitError(req, d.contentFormatId !== undefined ? d.contentFormatId : prior.content_format_id, ownerAfter);
        if (limit) return res.status(403).json({ error: limit });
      }
      if (briefChanged && !(own ? prior.created_by === req.user.sub : assigner && setUpBy(prior, req.user.sub))) {
        return res.status(403).json({
          error: own
            ? "This task was assigned to you — only an admin can change its title, description, type, dates, priority or repeat."
            : "Only an admin can change someone else's task.",
        });
      }
      if (workChanged && !own && !claiming && !(assigner && setUpBy(prior, req.user.sub))) {
        return res.status(403).json({ error: "Only an admin can change someone else's task." });
      }
    }

    if (d.editorId && d.editorId !== prior.editor_id) {
      const up = await aboveYouError(req, d.editorId);
      if (up) return res.status(403).json({ error: up });
    }

    // Project: keep the Due Date within [Start, Start + type's duration] on
    // update too (server-side, not just the picker). date columns come back as
    // "YYYY-MM-DD" strings, so range checks are plain string compares.
    if (prior.task_type === "project" || d.taskType === "project") {
      const effStart = d.startDate !== undefined ? (d.startDate || null) : prior.start_date;
      const effDue = d.dueDate !== undefined ? (d.dueDate || null) : prior.due_date;
      if (effStart && effDue) {
        if (effDue < effStart) return res.status(400).json({ error: "Due Date can't be before the Start Date." });
        const cfId = d.contentFormatId !== undefined ? (d.contentFormatId ?? null) : prior.content_format_id;
        const dur = cfId
          ? (await pool.query("select duration_days from task_content_format where id = $1 and org_id = $2", [cfId, req.orgId])).rows[0]?.duration_days ?? null
          : null;
        if (dur != null && effDue > addDaysYmd(effStart, dur)) {
          return res.status(400).json({ error: `Due Date must be within ${dur} day(s) of the Start Date.` });
        }
      }
    }

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
    let selfClosed = false;
    let holdAction = null;
    let budgetStartSet = false;
    if (d.status !== undefined && d.status !== prior.status) {
      if (prior.status === "review") {
        // Resolving a review (approve into done, or send back for rework)
        // follows one rule for everyone, admins included (../review-route.js):
        // whoever assigned it; for a task its owner made, a Team Lead, or a
        // Manager (a Team Lead's task, or after 24 hours). Never the owner.
        if (prior.editor_id && prior.editor_id === (await callerEditorId(req))) {
          return res.status(403).json({ error: "You can't review a task that's assigned to you." });
        }
        const route = routeReview(prior, await reviewContext(req.orgId));
        if (!route.reviewers.includes(req.user.sub)) {
          return res.status(403).json({
            error: route.kind === "assigner" ? `Only ${route.label}, who assigned this task, can review it.`
              : route.kind === "leads" && route.copyAt ? "A Team Lead reviews this task. A Manager can too once it has waited 24 hours."
              : route.kind === "leads" ? "Only a Team Lead or a Manager can review this task."
              : "Only a Manager can review this task.",
          });
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
          const link = d.deliveryLink !== undefined ? d.deliveryLink : prior.delivery_link;
          if (!link && !d.approveWithoutWork) {
            let required = prior.review_link_required;
            if (required == null && prior.content_format_id) {
              const { rows: cfRows } = await pool.query(
                "select review_link_required from task_content_format where id = $1 and org_id = $2",
                [prior.content_format_id, req.orgId],
              );
              required = cfRows[0]?.review_link_required ?? false;
            }
            if (required) {
              return res.status(409).json({ error: "No work is attached to this task. Confirm to approve it anyway.", code: "no_work_attached" });
            }
          }
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
        if (prior.status === "done") {
          // Completed is final for the assignee: it was approved, and its points
          // are counted. Reopening approved work is an admin's call, and it goes
          // back into the working stages, never to the pre-start To Do.
          if (req.role !== "admin") {
            return res.status(403).json({ error: "This task is completed — only an admin can reopen it." });
          }
          if (d.status === "todo") {
            return res.status(400).json({ error: "A completed task can be reopened to In progress or Review, not To Do." });
          }
        } else {
          // A held task is frozen until an admin resumes it (clears the hold).
          if (prior.on_hold && req.role !== "admin") {
            return res.status(403).json({
              error: prior.held_by === req.user.sub
                ? "This task is on hold — press Resume first."
                : "An admin put this task on hold — they need to resume it first.",
            });
          }
          const myEditorId = await callerEditorId(req);
          if (!prior.editor_id || myEditorId !== prior.editor_id) {
            return res.status(403).json({ error: "Only the person this task is assigned to can change its status." });
          }
          // Work starts with Accept — that's the moment the assignee takes the
          // task on, and, after a send-back, where they read what needs fixing.
          if (!prior.accepted) {
            return res.status(400).json({ error: "Accept this task first, then you can move it." });
          }
        }
      }
      // A reviewer needs the output to judge it: submitting for review requires
      // the delivery link, unless this content type is exempt (Task Settings).
      // Tasks with no content type (e.g. Admin tasks) have nothing to link.
      if (d.status === "review") {
        const cfId = d.contentFormatId !== undefined ? (d.contentFormatId ?? null) : prior.content_format_id;
        const link = d.deliveryLink !== undefined ? d.deliveryLink : prior.delivery_link;
        // The task's own setting wins; with none, fall back to its content type.
        let required = d.reviewLinkRequired !== undefined ? d.reviewLinkRequired : prior.review_link_required;
        if (required == null && cfId) {
          const { rows: cfRows } = await pool.query(
            "select review_link_required from task_content_format where id = $1 and org_id = $2", [cfId, req.orgId],
          );
          required = cfRows[0]?.review_link_required ?? false;
        }
        if (required && !link) {
          return res.status(400).json({ error: "Add your delivery link before submitting for review." });
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
      // An accepted task (assigned and accepted, made for yourself, or picked
      // up) starts its clock here, on Start — its move out of To Do. startAt
      // lets the board offer "start now or 9 AM tomorrow" after office hours.
      if (prior.status === "todo" && d.status === "in_progress" && prior.accepted
          && prior.budget_hours != null && !prior.budget_started_at) {
        const usedSec = Number(prior.budget_used_seconds ?? 0);
        const startAt = d.startAt ? new Date(d.startAt) : new Date();
        push("budget_started_at", new Date(startAt.getTime() - usedSec * 1000));
        push("budget_used_seconds", 0);
        budgetStartSet = true;
      }
      // A Manager's or Asst. Manager's own task needs no review: sending it
      // for review completes it (../review-route.js).
      if (d.status === "review" && prior.status !== "review"
          && routeReview(prior, await reviewContext(req.orgId)).kind === "none") {
        d.status = "done";
        selfClosed = true;
        reviewLogAction = "approved";
        reviewNote = "No review needed: a Manager's own task.";
      }
      // Time waiting for a reviewer never counts against the assignee: note
      // when it went into Review, and when it leaves (approved, sent back or
      // moved by an admin) add that wait to the total the score subtracts.
      if (d.status === "review") {
        sets.push("review_started_at = now()");
      } else if (prior.status === "review") {
        sets.push("review_wait_seconds = review_wait_seconds + greatest(0, extract(epoch from now() - coalesce(review_started_at, now())))");
        sets.push("review_started_at = null");
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
        // A hold an admin (or hold_tasks grantee) applied is theirs to lift —
        // the assignee can only resume a hold they put on themselves.
        if (!d.onHold && prior.held_by && prior.held_by !== req.user.sub) {
          return res.status(403).json({ error: "An admin put this task on hold — ask them to resume it." });
        }
      }
      holdAction = d.onHold ? "held" : "resumed";
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

    // Delivery Link — URL to the completed deliverable. Never on admin tasks
    // (they carry no content-related fields), and writable only by the task's
    // assignee or an admin (viewers can't reach this endpoint at all —
    // requireEditor). "" / null clears it.
    if (d.deliveryLink !== undefined) {
      if (prior.task_type === "admin") {
        return res.status(400).json({ error: "Admin tasks don't have a delivery link." });
      }
      if (req.role !== "admin") {
        const myEditorId = await callerEditorId(req);
        if (!prior.editor_id || myEditorId !== prior.editor_id) {
          return res.status(403).json({ error: "Only the task's assignee or an admin can set the delivery link." });
        }
      }
      push("delivery_link", d.deliveryLink ? d.deliveryLink : null);
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

    let aidSet = false;
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
      if (d.taskType === "social" || d.taskType === "ad" || d.taskType === "service" || d.taskType === "project") {
        const effChannel = d.channelId !== undefined ? (d.channelId ?? null) : prior.channel_id;
        // Ads: the team being set in this same PATCH, else the task's own
        const effTeam = d.adTeamId !== undefined ? (d.adTeamId ?? null) : prior.ad_team_id ?? null;
        if (d.taskType === "ad" ? !effChannel && !effTeam : !effChannel) {
          return res.status(400).json({ error: d.taskType === "ad" ? "Pick the team this ad is for first — Ads are numbered per team."
            : "Pick a Brand first — Social, Service and Project tasks are numbered per brand." });
        }
        if (d.taskType === "social" && !prior.sid) push("sid", await nextBrandTaskRef(effChannel, "sid"));
        if (d.taskType === "ad" && d.adTeamId && !(await activeTeam(d.adTeamId, req.orgId))) return res.status(400).json({ error: "Pick the team this ad is for." });
        if (d.taskType === "ad" && !prior.ad_id) { push("ad_id", await nextFreeAid(effTeam, effChannel)); aidSet = true; }
        if (d.taskType === "service" && !prior.svid) push("svid", await nextBrandTaskRef(effChannel, "svid"));
        if (d.taskType === "project" && !prior.pid) push("pid", await nextBrandTaskRef(effChannel, "pid"));
      }
    }
    if (d.contentFormatId !== undefined) push("content_format_id", d.contentFormatId ?? null);
    // The team an ad is for. AIDs count within a team, so a new team numbers it
    // afresh (with no team, its brand does), and its recorded ad numbers go with it.
    let adsMoveTo = null;
    if (d.adTeamId !== undefined && (d.adTeamId ?? null) !== (prior.ad_team_id ?? null) && (await adTeamsReady())) {
      if (d.adTeamId && !(await activeTeam(d.adTeamId, req.orgId))) {
        return res.status(400).json({ error: "Pick the team this ad is for." });
      }
      const isAd = (d.taskType ?? prior.task_type) === "ad";
      const effChannel = d.channelId !== undefined ? (d.channelId ?? null) : prior.channel_id;
      if (isAd && !d.adTeamId && !effChannel) {
        return res.status(400).json({ error: "Pick the team this ad is for — Ads are numbered per team." });
      }
      push("ad_team_id", d.adTeamId ?? null);
      if (isAd) {
        // an ad number the new team (or brand) already has on another task: one of them lets go first
        if (await hasColumn("task_ad", "ad_team_id")) {
          const { rows: clash } = await pool.query(
            `select a.ad_ref from task_ad a
              where a.task_id = $1 and exists (select 1 from task_ad b where b.task_id <> $1
                and coalesce(b.ad_team_id, b.workspace_id) = $2 and lower(b.ad_ref) = lower(a.ad_ref)) limit 1`,
            [req.params.id, d.adTeamId ?? effChannel],
          );
          if (clash.length) {
            return res.status(409).json({ error: `${clash[0].ad_ref} is already recorded on another task of that ${d.adTeamId ? "team" : "brand"} — remove it from one of them first.` });
          }
          adsMoveTo = { team: d.adTeamId ?? null, channel: effChannel };
        }
        if (!aidSet) push("ad_id", await nextFreeAid(d.adTeamId ?? null, effChannel));
      }
    }
    if (d.reviewLinkRequired !== undefined && (d.reviewLinkRequired ?? null) !== (prior.review_link_required ?? null)) {
      // The assignee can't waive their own review link — only an admin, or
      // someone who may assign work (the Assign tasks grant) and set this task
      // up: they gave it, or made it for themselves. Mirrored by the switch
      // in the task panel (pulse-app/src/pages/tasks.tsx).
      const mineMade = prior.created_by === req.user.sub && !prior.assigned_by;
      const setUp = (mineMade || setUpBy(prior, req.user.sub)) && (await hasActiveGrant(req.orgId, req.user.sub, "assign_tasks"));
      if (req.role !== "admin" && !setUp) {
        return res.status(403).json({ error: "Only an admin, or someone who can assign tasks and set this one up, can change whether it needs a review link." });
      }
      push("review_link_required", d.reviewLinkRequired);
    }
    // Requested by lives in meta but is its own field: a meta edit keeps it
    if (d.meta !== undefined || d.requestedBy !== undefined) {
      const next = { ...(d.meta !== undefined ? d.meta : prior.meta ?? {}) };
      const asked = d.requestedBy !== undefined ? d.requestedBy || null : prior.meta?.requestedBy ?? null;
      if (asked) next.requestedBy = asked; else delete next.requestedBy;
      push("meta", JSON.stringify(next));
    }

    // Reassigning — resets acceptance unless it's a no-op (same editor) or a
    // self-assign (claiming, or a manager assigning their own work to themselves).
    let accepted = prior.accepted;
    if (d.editorId !== undefined) {
      const nextEditorId = d.editorId ?? null;
      push("editor_id", nextEditorId);
      if (nextEditorId !== prior.editor_id) {
        const toSelf = (await callerEditorId(req)) === nextEditorId;
        accepted = !nextEditorId || toSelf;
        push("accepted", accepted);
        push("assigned_by", nextEditorId && !toSelf ? req.user.sub : null);
        // Covered work: a task its person had accepted, now someone else's
        // (server/src/goal-score.js). Fixing an assignment nobody had taken on
        // yet isn't cover; going back to its first person ends it.
        // Only work someone was given counts: moving a task its owner made for
        // themselves is a fresh assignment, not cover.
        if (await hasColumn("task", "covered_from_editor_id")) {
          const given = !!prior.covered_from || !!prior.assigned_by;
          push("covered_from_editor_id", given ? coverFrom(prior.covered_from ?? null, prior.accepted ? prior.editor_id : null, nextEditorId) : null);
        }
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
      // the time it was given (Should take) stays unless the work itself changed
      const sameWork = effectiveEditorId === prior.editor_id && effectiveFormatId === prior.content_format_id;
      const budgetHours = d.budgetHours != null ? d.budgetHours
        : sameWork && prior.budget_hours != null ? Number(prior.budget_hours)
        : await resolveBudgetHours(req.orgId, effectiveEditorId, effectiveFormatId);
      push("budget_hours", budgetHours);
      // A task that hasn't been started (still To Do) keeps its clock stopped.
      const runs = budgetHours !== null && accepted && (prior.status !== "todo" || budgetStartSet);
      if (!budgetStartSet) push("budget_started_at", runs ? (d.startAt ? new Date(d.startAt) : new Date()) : null);
      // Handing it to someone new — any time banked from the previous
      // assignee's paused work session doesn't carry over to them.
      if (d.editorId !== undefined && d.editorId !== prior.editor_id) push("budget_used_seconds", 0);
    } else if (!budgetStartSet && d.startAt !== undefined && prior.accepted && prior.budget_hours != null && prior.budget_started_at) {
      // Pure reschedule — nothing else about the task changed, just when its
      // already-running clock should count from (e.g. deferring a self-assign
      // made after office hours to 9 AM tomorrow instead).
      push("budget_started_at", new Date(d.startAt));
    }
    // Should take changed on its own: the budget changes, the clock doesn't
    if (d.budgetHours !== undefined && d.contentFormatId === undefined && d.editorId === undefined && prior.task_type !== "admin") {
      push("budget_hours", d.budgetHours ?? await resolveBudgetHours(req.orgId, prior.editor_id, prior.content_format_id));
    }
    // The points a completed task earns: its type's points the moment it's
    // approved, kept from then on, so changing a type's points never rewrites
    // it. Reopened and approved again, it keeps them; only a change of content
    // type scores it afresh (at the new type's points, or on its next approval).
    if (await hasColumn("task", "points_at_done")) {
      const formatChanged = d.contentFormatId !== undefined && (d.contentFormatId ?? null) !== (prior.content_format_id ?? null);
      const endsDone = (d.status ?? prior.status) === "done";
      if (formatChanged && endsDone) {
        params.push(d.contentFormatId ?? null);
        sets.push(`points_at_done = (select cf.points from task_content_format cf where cf.id = $${params.length})`);
      } else if (formatChanged) {
        sets.push("points_at_done = null");
      } else if (d.status === "done" && prior.status !== "done") {
        sets.push("points_at_done = coalesce(task.points_at_done, (select cf.points from task_content_format cf where cf.id = task.content_format_id))");
      }
    }
    // the status it already has (a second tap, or someone else got there first)
    if (!sets.length && d.status !== undefined && d.status === prior.status) {
      const words = { todo: "to do", in_progress: "in progress", review: "in review", done: "done" };
      return res.status(409).json({ error: `This task is already ${words[prior.status] ?? prior.status}.` });
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    // A status change counts only from the status it was read in: two people
    // answering the same review at once — the second is told, not counted twice
    // (no second next repeat, no "approved" over a send-back).
    const moving = d.status !== undefined && d.status !== prior.status;
    if (moving) params.push(prior.status);
    const { rows } = await pool.query(
      `update task set ${sets.join(", ")} where id = $1 and org_id = $2${moving ? ` and status = $${params.length}` : ""} returning id`,
      params,
    );
    if (!rows.length && moving) return res.status(409).json({ error: "Someone else just changed this task. Reload it and try again." });
    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    // its recorded ads, to the team it moved to (with none, its brand)
    if (adsMoveTo) {
      await pool.query(
        "update task_ad set ad_team_id = $2, workspace_id = case when $2::uuid is null then $3::uuid else workspace_id end where task_id = $1",
        [req.params.id, adsMoveTo.team, adsMoveTo.channel],
      );
    }

    const finalStatus = d.status ?? prior.status;
    const finalRecurrence = d.recurrence ?? prior.recurrence;
    // Given to someone another way, or sent on to Review / Completed: a
    // waiting hand-over is over (../handover.js).
    if ((d.editorId !== undefined && (d.editorId ?? null) !== prior.editor_id) || finalStatus === "review" || finalStatus === "done") {
      await closePendingHandovers(req.params.id);
    }
    if (prior.status !== "done" && finalStatus === "done" && finalRecurrence !== "none") {
      await spawnNextOccurrence(req.params.id, finalRecurrence);
    }
    // Approved social work goes into the schedulers' shared list (../scheduling.js);
    // reopened before any link went in, it comes back out.
    const toScheduling = prior.status !== "done" && finalStatus === "done" ? await enterScheduling(req.params.id) : false;
    if (prior.status === "done" && finalStatus !== "done") await leaveScheduling(req.params.id);
    // ...and approved Ad work into Ad uploads (../ad-uploads.js), the same way
    if (prior.status !== "done" && finalStatus === "done") await enterUploads(req.params.id);
    if (prior.status === "done" && finalStatus !== "done") await leaveUploads(req.params.id);

    const { rows: full } = await pool.query(`${await taskSelect()} where t.id = $1`, [req.params.id]);
    // Log the moment a task is marked complete.
    if (prior.status !== "done" && finalStatus === "done") {
      await logActivity({
        orgId: req.orgId,
        actorId: req.user.sub,
        verb: "completed",
        entityType: "task",
        entityId: full[0].id,
        channelId: full[0].channel_id,
        summary: selfClosed ? `Completed task “${full[0].title}” (no review needed)` : `Approved task “${full[0].title}”`,
      });
    }
    // ...and this month's schedulers are told it's ready
    if (toScheduling) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "schedule_ready", entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
        summary: `${full[0].sid ?? full[0].tid} “${full[0].title}” is approved and ready to schedule`,
        meta: { notifyEditorIds: await schedulerIds(req.orgId) },
      });
    }
    // Handed to someone else — the new assignee needs to know.
    if (d.editorId && d.editorId !== prior.editor_id) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "assigned",
        entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
        summary: `Assigned task “${full[0].title}” to ${full[0].editor_name ?? "a team member"}`,
        // Who had it before — they see this in their feed too (see activity.js).
        meta: { fromEditorId: prior.editor_id, toEditorId: d.editorId },
      });
    }
    if (holdAction) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: holdAction,
        entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
        summary: holdAction === "held" ? `Put task “${full[0].title}” on hold` : `Resumed task “${full[0].title}”`,
      });
    }
    // Submitted for review / sent back for rework — these are what reviewers
    // and the assignee respectively need a notification for.
    if (prior.status === "done" && finalStatus !== "done") {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "reopened",
        entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
        summary: `Reopened completed task “${full[0].title}”`,
      });
    } else if (prior.status !== "review" && finalStatus === "review") {
      // Told: whoever reviews it now (the Managers' 24-hour copy comes later).
      const route = routeReview(full[0], await reviewContext(req.orgId));
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "review_requested",
        entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
        summary: `Submitted task “${full[0].title}” for review`,
        meta: { notifyUserIds: route.reviewers },
      });
    }
    if (reviewLogAction === "sent_back") {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "sent_back",
        entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
        summary: `Sent back task “${full[0].title}” for rework`,
        // The reason, so the feed says what needs fixing.
        meta: { note: reviewNote },
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
    res.json({ task: await withReview(req, full[0]) });
  } catch (err) {
    next(err);
  }
});

// Accept an assignment — only the assignee themselves, and only once. For a
// task in To Do it just marks it theirs; the timer starts later, on Start. For
// one already under way (sent back for rework) it resumes the countdown.
// startAt lets the client defer that resume (e.g. "9am tomorrow" when resuming
// now would run past office close) — client computes the wall-clock time since
// office hours are a local-time concept, not something the server should guess at.
tasksRouter.post("/tasks/:id/accept", requireEditor, requireActiveEod, async (req, res, next) => {
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
    if (prior.status === "todo") {
      // Accepting a task still in To Do only says "it's mine": it stays in To
      // Do with no timer running, and starts (status + clock) when the
      // assignee presses Start — see the To Do → In Progress move in PATCH.
      await pool.query(
        "update task set accepted = true, pending_note = null where id = $1 and org_id = $2",
        [req.params.id, req.orgId],
      );
    } else {
      // Already under way (sent back from review, or handed over mid-work):
      // accepting resumes it. The start point shifts back by however much was
      // already banked, so the countdown reflects only what's actually left,
      // not a fresh budget_hours.
      const usedSec = Number(prior.budget_used_seconds ?? 0);
      const effectiveStart = usedSec > 0 ? new Date(startAt.getTime() - usedSec * 1000) : startAt;
      await pool.query(
        `update task
            set accepted = true, budget_started_at = $3, budget_used_seconds = 0, pending_note = null
          where id = $1 and org_id = $2`,
        [req.params.id, req.orgId, prior.budget_hours != null ? effectiveStart : null],
      );
    }
    const { rows: full } = await pool.query(`${await taskSelect()} where t.id = $1`, [req.params.id]);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "accepted", entityType: "task", entityId: full[0].id, channelId: full[0].channel_id,
      summary: `Accepted task “${full[0].title}”`,
    });
    res.json({ task: await withReview(req, full[0]) });
  } catch (err) {
    next(err);
  }
});

// A task's History (its panel): everything that happened to it, oldest first —
// created (and for whom), assigned, accepted, handed over, reviewed.
tasksRouter.get("/tasks/:id/history", async (req, res, next) => {
  try {
    if (!(await mayOpenTask(req, req.params.id))) return res.status(403).json({ error: "You can't open this task." });
    const { rows } = await pool.query(
      `select a.id, a.verb, a.summary, a.created_at, a.actor_id, coalesce(u.name, u.email) as actor_name
         from activity a left join app_user u on u.id = a.actor_id
        where a.org_id = $1 and a.entity_type = 'task' and a.entity_id = $2
        order by a.created_at, a.id`,
      [req.orgId, req.params.id],
    );
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
});

// When a recurring task is completed, create its next occurrence (fresh, To Do,
// due date advanced) and copy its checklist items unchecked.
async function spawnNextOccurrence(taskId, recurrence) {
  try {
    const t = (await pool.query(
      "select org_id, editor_id, channel_id, title, description, priority, due_date, task_type, content_format_id, review_link_required, created_by, assigned_by, (to_jsonb(task)->>'ad_team_id')::uuid as ad_team_id from task where id = $1",
      [taskId],
    )).rows[0];
    if (!t) return;
    const days = recurrence === "weekly" ? 7 : 1;
    // Advance from the current due date if set, else from today.
    const nextDue = `(coalesce($7::date, (now() at time zone 'Asia/Kolkata')::date) + interval '${days} day')::date`;
    // Fresh occurrence gets its own budget snapshot, resolved against
    // whatever rules apply right now (not copied from the completed one) —
    // and its own TID, being a distinct row (a recurring Social/Ad task also
    // gets a fresh SID/AdID, same as any other task of that type).
    const budgetHours = await resolveBudgetHours(t.org_id, t.editor_id, t.content_format_id);
    const tid = await nextTaskRef(t.org_id, "tid");
    const sid = t.task_type === "social" && t.channel_id ? await nextBrandTaskRef(t.channel_id, "sid") : null;
    const adId = t.task_type !== "ad" ? null : t.ad_team_id || t.channel_id ? await nextFreeAid(t.ad_team_id, t.channel_id) : null;
    const svid = t.task_type === "service" && t.channel_id ? await nextBrandTaskRef(t.channel_id, "svid") : null;
    const { rows } = await pool.query(
      `insert into task (org_id, editor_id, channel_id, title, description, priority, due_date, recurrence, status, task_type, content_format_id, budget_hours, budget_started_at, tid, sid, ad_id, svid, review_link_required, accepted, created_by, assigned_by)
       values ($1,$2,$3,$4,$5,$6, ${nextDue}, $8, 'todo', $9, $10, $11, null, $12, $13, $14, $15, $16, false, $17, $18) returning id`,
      [t.org_id, t.editor_id, t.channel_id, t.title, t.description, t.priority, t.due_date, recurrence, t.task_type, t.content_format_id, budgetHours, tid, sid, adId, svid, t.review_link_required, t.created_by, t.assigned_by],
    );
    const newId = rows[0].id;
    if (t.ad_team_id) await pool.query("update task set ad_team_id = $2 where id = $1", [newId, t.ad_team_id]);
    await pool.query(
      "insert into subtask (task_id, title, sort_order) select $1, title, sort_order from subtask where task_id = $2",
      [newId, taskId],
    );
  } catch (err) {
    console.error("spawnNextOccurrence failed:", err.message);
  }
}

// Deleting erases the work, its history and its points. A completed task: an
// admin only. Anything else: an admin or an assign_tasks grantee — or the person
// who created the task for themselves. Every deletion is written to the feed.
tasksRouter.delete("/tasks/:id", requireEditor, async (req, res, next) => {
  try {
    const t = (await pool.query(
      "select title, tid, status, editor_id, channel_id, created_by, assigned_by from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!t) return res.status(404).json({ error: "Task not found" });
    if (req.role !== "admin") {
      if (t.status === "done") {
        return res.status(403).json({ error: "This task is completed — only an admin can delete it." });
      }
      // Yours, made for yourself; or, with Assign tasks, one you set up.
      const myEid = await callerEditorId(req);
      const ownCreation = t.created_by === req.user.sub && !!myEid && t.editor_id === myEid;
      const setUp = setUpBy(t, req.user.sub) && (await hasActiveGrant(req.orgId, req.user.sub, "assign_tasks"));
      if (!ownCreation && !setUp) return res.status(403).json({ error: "You can delete only tasks you made for yourself or assigned." });
    }
    const { rowCount } = await pool.query(
      "delete from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Task not found" });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "deleted",
      entityType: "task", entityId: req.params.id, channelId: t.channel_id,
      summary: `Deleted task “${t.title}”`,
      // The task row is gone — keep who it belonged to, so they still see this.
      meta: { tid: t.tid, editorId: t.editor_id },
    });
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

// The checklist is part of working a task: its assignee, an admin or an
// assign_tasks grantee may change it — and once the task is completed, only an
// admin. Returns null when allowed, else the { status, error } to send.
async function checklistRefusal(req, task) {
  if (!task) return { status: 404, error: "Task not found" };
  if (req.role === "admin") return null;
  if (task.status === "done") return { status: 403, error: "This task is completed — only an admin can change it." };
  const myEid = await callerEditorId(req);
  if (myEid && task.editor_id === myEid) return null;
  if (task.assigned_by === req.user.sub && (await hasActiveGrant(req.orgId, req.user.sub, "assign_tasks"))) return null;
  return { status: 403, error: "Only an admin can change someone else's task." };
}
async function taskOfSubtask(subtaskId, orgId) {
  const { rows } = await pool.query(
    `select t.id, t.status, t.editor_id, t.assigned_by from subtask s join task t on t.id = s.task_id
      where s.id = $1 and t.org_id = $2`,
    [subtaskId, orgId],
  );
  return rows[0] ?? null;
}

// Every review decision on this task — sent back (with its note) or
// approved — newest first, so the team can see exactly what changed each
// revision and why.
tasksRouter.get("/tasks/:id/reviews", async (req, res, next) => {
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    if (!(await mayOpenTask(req, req.params.id))) return res.status(404).json({ error: "Task not found" });
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
    if (!(await mayOpenTask(req, req.params.id))) return res.status(404).json({ error: "Task not found" });
    const { rows } = await pool.query(
      "select id, title, done, sort_order from subtask where task_id = $1 order by sort_order, created_at",
      [req.params.id],
    );
    res.json({ subtasks: rows });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/tasks/:id/subtasks", requireEditor, requireActiveEod, async (req, res, next) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "A checklist item needs a title." });
  if (title.length > 300) return res.status(400).json({ error: "A checklist item can be up to 300 characters." });
  try {
    const parent = (await pool.query("select id, status, editor_id, assigned_by from task where id = $1 and org_id = $2", [req.params.id, req.orgId])).rows[0];
    const refusal = await checklistRefusal(req, parent);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
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

tasksRouter.patch("/subtasks/:id", requireEditor, requireActiveEod, async (req, res, next) => {
  const sets = [];
  const params = [req.params.id, req.orgId];
  if (typeof req.body?.done === "boolean") { params.push(req.body.done); sets.push(`done = $${params.length}`); }
  if (typeof req.body?.title === "string" && req.body.title.trim()) { params.push(req.body.title.trim()); sets.push(`title = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  if (typeof req.body?.title === "string" && req.body.title.trim().length > 300) return res.status(400).json({ error: "A checklist item can be up to 300 characters." });
  try {
    const parent = await taskOfSubtask(req.params.id, req.orgId);
    if (!parent) return res.status(404).json({ error: "Checklist item not found" });
    const refusal = await checklistRefusal(req, parent);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
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

tasksRouter.delete("/subtasks/:id", requireEditor, requireActiveEod, async (req, res, next) => {
  try {
    const parent = await taskOfSubtask(req.params.id, req.orgId);
    if (!parent) return res.status(404).json({ error: "Checklist item not found" });
    const refusal = await checklistRefusal(req, parent);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
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
    if (!(await mayOpenTask(req, req.params.id))) return res.status(404).json({ error: "Task not found" });
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

// Viewers have read-only access — commenting is for the team doing the work.
tasksRouter.post("/tasks/:id/comments", requireEditor, async (req, res, next) => {
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "Write a comment first." });
  if (body.length > 4000) return res.status(400).json({ error: "A comment can be up to 4,000 characters." });
  try {
    if (!(await ownsTask(req.params.id, req.orgId))) return res.status(404).json({ error: "Task not found" });
    // only on a task you may open (as reading its comments)
    if (!(await mayOpenTask(req, req.params.id))) return res.status(404).json({ error: "Task not found" });
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
