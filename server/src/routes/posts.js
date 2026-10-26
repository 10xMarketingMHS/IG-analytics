import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { assignLimits, requirePermission } from "../permissions.js";
import { requirePage } from "../page-access.js";
import { logActivity } from "../activity.js";
import { resolveBudgetHours, nextTaskRef, nextBrandTaskRef, callerEditorId, canAssignTasks, setUpBy } from "./tasks.js";
import { closePendingHandovers } from "../handover.js";
import { editorRanks, seesEditor, taskViewer } from "../hierarchy.js";

// The person on a post gets its editing task, so naming them is assigning work:
// yourself is fine; anyone else (or taking someone else's) needs Assign tasks,
// within its people limit, as on the Task Board. They must be on this team.
async function personError(req, nextEditorId, priorEditorId = null, formatId = null) {
  if (nextEditorId) {
    const { rows } = await pool.query("select 1 from editor where id = $1 and org_id = $2", [nextEditorId, req.orgId]);
    if (!rows.length) return { status: 400, error: "That team member wasn't found." };
  }
  const me = await callerEditorId(req);
  const forOther = !!nextEditorId && nextEditorId !== me;
  const fromOther = !!priorEditorId && priorEditorId !== me;
  if (!forOther && !fromOther) return null;
  // never to someone above you, as on the task board (the Super Admin: anyone)
  if (forOther) {
    const [viewer, ranks] = await Promise.all([taskViewer(req), editorRanks(req.orgId)]);
    if (!seesEditor(viewer, ranks, nextEditorId)) return { status: 403, error: "You can't give work to someone above you." };
  }
  if (req.role === "admin") return null;
  if (!(await canAssignTasks(req))) return { status: 403, error: "Giving a post's editing to someone else needs Assign tasks access." };
  const lim = await assignLimits(req.orgId, req.user.sub);
  if (forOther && lim?.editors && !lim.editors.includes(nextEditorId)) {
    return { status: 403, error: "You can't assign work to that person." };
  }
  // limited to some content types: the post's task must be one of them
  if (forOther && lim?.formats && !(formatId && lim.formats.includes(formatId))) {
    return { status: 403, error: "Your Assign tasks access doesn't cover this kind of task." };
  }
  return null;
}
// The content type a post's editing task gets (reel → Video, carousel → Image),
// as syncPostTask picks it.
async function postTaskFormat(orgId, postType) {
  const { rows } = await pool.query(
    "select id from task_content_format where org_id = $1 and active and lower(name) = $2 limit 1",
    [orgId, postType === "carousel" ? "image" : "video"],
  );
  return rows[0]?.id ?? null;
}

export const postsRouter = Router();

const CreatePostSchema = z.object({
  date: z.string().min(1),
  title: z.string().min(1),
  caption: z.string().optional(),
  pillarId: z.string().uuid(),
  contentTypeId: z.string().uuid(),
  formatId: z.string().uuid(),
  avatarId: z.string().uuid(),
  editorId: z.string().uuid().optional().or(z.literal("")),
  channelId: z.string().uuid().optional(), // which channel to create the post in
  platformId: z.string().uuid().optional(), // which platform (IG/FB/YT)
  collabChannelId: z.string().uuid().nullable().optional(), // collab with another channel
  collabGroupId: z.string().uuid().nullable().optional(), // links a collab owner+mirror pair
  isCollabMirror: z.boolean().optional(), // this row is the collaborating channel's mirror
  link: z.string().url().optional().or(z.literal("")), // published post URL (→ permalink)
  postType: z.enum(["reel", "carousel"]).optional(),
  status: z.enum(["planned", "published"]).default("planned"),
  editStage: z.enum(["not_started", "in_progress", "in_review", "pending", "completed"]).optional(),
  views: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  saves: z.number().int().nonnegative().optional(),
  reach: z.number().int().nonnegative().optional(),
  permalink: z.string().url().optional().or(z.literal("")),
  thumbnailUrl: z.string().url().optional().or(z.literal("")),
  notes: z.string().optional(),
});

const UpdatePostSchema = CreatePostSchema.partial();

const POST_COLUMNS = `
  id, date, title, caption, pillar_id, content_type_id, format_id, avatar_id,
  editor_id, platform_id, collab_channel_id, collab_group_id, is_collab_mirror,
  post_type, status, edit_stage, published_at, views, likes, comments, shares,
  saves, reach, metrics_updated_at, permalink, thumbnail_url, notes, source,
  created_at, updated_at
`;

const EDIT_STAGES = ["not_started", "in_progress", "in_review", "pending", "completed"];

// Keep a Task Management task in sync with a post's assigned editor. Creates the
// task when a post has an editor and none exists yet; updates it (reassign /
// retitle / re-date) otherwise. No-op when the post has no editor.
// callerUserId: whoever is making this post write — if they're assigning the
// post to someone else, that task needs an explicit accept; assigning to
// themselves (their own linked editor) accepts it immediately.
// keepBrief: the caller may change the post but not its task's title and due
// date (a task given to them, or someone else's): those stay as they were.
async function syncPostTask(postId, orgId, callerUserId, { keepBrief = false } = {}) {
  try {
    const { rows } = await pool.query(
      "select id, editor_id, title, date, workspace_id, is_collab_mirror, post_type, status from post where id = $1 and deleted_at is null",
      [postId],
    );
    const post = rows[0];
    // A collab mirror represents the same physical work as its owner — never
    // give it its own task (it also carries no editor by design).
    if (!post || !post.editor_id || post.is_collab_mirror) return;
    let accepted = true;
    if (callerUserId) {
      const { rows: urows } = await pool.query("select editor_id from app_user where id = $1", [callerUserId]);
      accepted = urows[0]?.editor_id === post.editor_id;
    }
    // A post-linked task is editing work — default its production format from
    // the post's own type (reel → Video, carousel → Image) so it gets a time
    // budget automatically, the same as a manually-created task would. Falls
    // through to no format (and no timer) if the org renamed/removed those.
    const wantName = post.post_type === "carousel" ? "image" : "video";
    const { rows: fmtRows } = await pool.query(
      "select id from task_content_format where org_id = $1 and active and lower(name) = $2 limit 1",
      [orgId, wantName],
    );
    const defaultFormatId = fmtRows[0]?.id ?? null;

    const existing = await pool.query(
      "select id, editor_id, accepted, content_format_id, sid, status from task where post_id = $1",
      [postId],
    );
    if (existing.rows.length) {
      const prior = existing.rows[0];
      // given to someone else another way: a waiting hand-over is over
      if (prior.editor_id !== post.editor_id) await closePendingHandovers(prior.id);
      // Waiting for review or completed: its person, title and due date stay as
      // they were reviewed (moving it would move the work's points).
      if (prior.status === "review" || prior.status === "done") return;
      // Reassigning to a different editor re-opens acceptance for them.
      const nextAccepted = prior.editor_id === post.editor_id ? prior.accepted : accepted;
      // Never override a format the user already picked (manually or via an
      // earlier sync) — only fill it in the first time.
      const nextFormatId = prior.content_format_id ?? defaultFormatId;
      const budgetHours = await resolveBudgetHours(orgId, post.editor_id, nextFormatId);
      // A post-linked task is social-media editing work — same "Social" bucket
      // as a manually-typed social task, so it gets an SID too (backfilled for
      // rows created before this existed) — from the same per-brand counter the
      // board uses, or the numbers clash and the save fails.
      const sid = prior.sid ?? await nextBrandTaskRef(post.workspace_id, "sid");
      await pool.query(
        `update task set editor_id = $1, channel_id = $4, accepted = $5,
                title = case when $10 then title else $2 end, due_date = case when $10 then due_date else $3 end,
                content_format_id = $6, budget_hours = $7, sid = $9,
                budget_started_at = case when $5 then budget_started_at else null end,
                assigned_by = case when editor_id is distinct from $1 then $11 else assigned_by end
          where post_id = $8`,
        [post.editor_id, post.title, post.date, post.workspace_id, nextAccepted, nextFormatId, budgetHours, postId, sid,
          keepBrief, accepted ? null : callerUserId ?? null],
      );
    } else {
      // A post entered after it was published has no editing left to do — a
      // fresh To Do task due on a past date would only show up as overdue work
      // (and count as late). Tasks are made for posts still being prepared.
      if (post.status === "published") return;
      const budgetHours = await resolveBudgetHours(orgId, post.editor_id, defaultFormatId);
      const tid = await nextTaskRef(orgId, "tid");
      const sid = await nextBrandTaskRef(post.workspace_id, "sid");
      await pool.query(
        `insert into task (org_id, post_id, editor_id, channel_id, title, due_date, status, priority,
                           task_type, accepted, content_format_id, budget_hours, budget_started_at, tid, sid, created_by, assigned_by)
         values ($1, $2, $3, $4, $5, $6, 'todo', 'medium', 'content', $7, $8, $9, null, $10, $11, $12, $13)`,
        [orgId, postId, post.editor_id, post.workspace_id, post.title, post.date, accepted, defaultFormatId, budgetHours, tid, sid,
          callerUserId ?? null, accepted ? null : callerUserId ?? null],
      );
    }
  } catch (err) {
    // A task-sync failure must never break the post write.
    console.error("syncPostTask failed:", err.message);
  }
}

// Prefixed column list for queries that join `workspace` (id/name collide).
const P_COLS = POST_COLUMNS.split(",")
  .map((c) => `p.${c.trim()}`)
  .join(", ");

// GET /posts
//   ?channel=all         → every post across all channels in the org (dashboard)
//   ?channel=<id>        → one specific channel (validated against the org)
//   (no channel param)   → the active channel only (Posts page — unchanged)
// The channel=all / specific responses also include channel_id + channel_name.
postsRouter.get("/posts", async (req, res, next) => {
  try {
    const { status, channel } = req.query;
    const params = [];
    let where;
    let join = "";
    let extraCols = "";

    if (channel === "all") {
      params.push(req.orgId);
      join = "join workspace w on w.id = p.workspace_id";
      extraCols = ", p.workspace_id as channel_id, w.name as channel_name";
      where = `w.org_id = $${params.length} and p.deleted_at is null`;
    } else if (channel) {
      params.push(channel, req.orgId);
      join = "join workspace w on w.id = p.workspace_id";
      extraCols = ", p.workspace_id as channel_id, w.name as channel_name";
      where = "p.workspace_id = $1 and w.org_id = $2 and p.deleted_at is null";
    } else {
      params.push(req.workspaceId);
      where = "p.workspace_id = $1 and p.deleted_at is null";
    }

    if (status === "planned" || status === "published") {
      params.push(status);
      where += ` and p.status = $${params.length}`;
    }
    // Platform drill-down (dashboard platform cards).
    if (req.query.platform) {
      params.push(req.query.platform);
      where += ` and p.platform_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `select ${P_COLS}${extraCols} from post p ${join}
       where ${where} order by p.date desc, p.created_at desc`,
      params,
    );
    res.json({ posts: rows });
  } catch (err) {
    next(err);
  }
});

// GET /posts/count — how many posts this channel has (the sidebar's number),
// without sending every post.
postsRouter.get("/posts/count", async (req, res, next) => {
  try {
    const { rows } = await pool.query("select count(*)::int as n from post where workspace_id = $1 and deleted_at is null", [req.workspaceId]);
    res.json({ count: rows[0].n });
  } catch (err) {
    next(err);
  }
});

postsRouter.get("/posts/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${POST_COLUMNS} from post
       where id = $1 and workspace_id = $2 and deleted_at is null`,
      [req.params.id, req.workspaceId],
    );
    if (!rows.length) return res.status(404).json({ error: "Post not found" });
    res.json({ post: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Admin/editor by role, OR a viewer holding the create_post grant. A grant-only
// creator is self-scoped below (they can only assign the post to themselves).
postsRouter.post("/posts", requirePermission("create_post", { alsoAllow: ["editor"], message: "You don't have permission to create posts." }), async (req, res, next) => {
  const parsed = CreatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const p = parsed.data;

  try {
    // create_post is self-scoped: a grant-only creator can only ever assign the
    // auto-created task to THEMSELVES. Force the editor to their own record
    // (null if they aren't linked to one → the post is simply left unassigned),
    // never someone else's — this is the one place creating a post would
    // otherwise reach into another user's task queue.
    if (req.viaGrant?.create_post) {
      const { rows: u } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
      p.editorId = u[0]?.editor_id ?? null;
    }
    const who = await personError(req, p.editorId || null, null, await postTaskFormat(req.orgId, p.postType));
    if (who) return res.status(who.status).json({ error: who.error });
    // Target channel: the chosen one (validated to belong to the org) or the
    // active channel. Prevents writing into a channel outside your org.
    let targetWs = req.workspaceId;
    if (p.channelId && p.channelId !== req.workspaceId) {
      const { rows: ok } = await pool.query(
        "select 1 from workspace where id = $1 and org_id = $2",
        [p.channelId, req.orgId],
      );
      if (!ok.length) return res.status(400).json({ error: "Unknown channel" });
      targetWs = p.channelId;
    }

    const { rows } = await pool.query(
      `insert into post (
         workspace_id, date, title, caption, pillar_id, content_type_id,
         format_id, avatar_id, editor_id, post_type, status, views, likes, comments, shares,
         saves, reach, permalink, thumbnail_url, notes, created_by, platform_id, collab_channel_id, edit_stage,
         collab_group_id, is_collab_mirror
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       returning ${POST_COLUMNS}`,
      [
        targetWs,
        p.date,
        p.title,
        p.caption ?? null,
        p.pillarId,
        p.contentTypeId,
        p.formatId,
        p.avatarId,
        p.editorId || null,
        p.postType ?? null,
        p.status,
        p.views ?? 0,
        p.likes ?? 0,
        p.comments ?? 0,
        p.shares ?? 0,
        p.saves ?? 0,
        p.reach ?? 0,
        p.link || p.permalink || null,
        p.thumbnailUrl || null,
        p.notes ?? null,
        req.user.sub,
        p.platformId ?? null,
        p.collabChannelId ?? null,
        p.editStage ?? "not_started",
        p.collabGroupId ?? null,
        p.isCollabMirror ?? false,
      ],
    );
    // Auto-create a Task Management task for the assigned editor.
    await syncPostTask(rows[0].id, req.orgId, req.user.sub);
    await logActivity({
      orgId: req.orgId,
      actorId: req.user.sub,
      verb: rows[0].status === "published" ? "published" : "created",
      entityType: "post",
      entityId: rows[0].id,
      channelId: targetWs,
      summary: rows[0].status === "published" ? `Published “${rows[0].title}”` : `Added post “${rows[0].title}”`,
    });
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    next(err);
  }
});

postsRouter.patch("/posts/:id", requireEditor, requirePage("posts"), async (req, res, next) => {
  const parsed = UpdatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const p = parsed.data;

  const fieldMap = {
    date: "date",
    title: "title",
    caption: "caption",
    pillarId: "pillar_id",
    contentTypeId: "content_type_id",
    formatId: "format_id",
    avatarId: "avatar_id",
    editorId: "editor_id",
    platformId: "platform_id",
    collabChannelId: "collab_channel_id",
    link: "permalink",
    postType: "post_type",
    status: "status",
    editStage: "edit_stage",
    views: "views",
    likes: "likes",
    comments: "comments",
    shares: "shares",
    saves: "saves",
    reach: "reach",
    permalink: "permalink",
    thumbnailUrl: "thumbnail_url",
    notes: "notes",
  };

  const sets = [];
  const params = [req.params.id, req.workspaceId];
  for (const [key, column] of Object.entries(fieldMap)) {
    if (p[key] === undefined) continue;
    params.push(p[key] === "" ? null : p[key]);
    sets.push(`${column} = $${params.length}`);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    // Capture prior status/stage so we log only genuine transitions.
    const prior = (await pool.query(
      "select status, edit_stage, workspace_id, editor_id, post_type, title, date::text as date from post where id = $1 and workspace_id = $2 and deleted_at is null",
      [req.params.id, req.workspaceId],
    )).rows[0];
    if (prior && p.editorId !== undefined && (p.editorId || null) !== (prior.editor_id ?? null)) {
      const { rows: linked } = await pool.query("select status, content_format_id from task where post_id = $1", [req.params.id]);
      if (linked[0] && (linked[0].status === "review" || linked[0].status === "done")) {
        return res.status(409).json({ error: linked[0].status === "review"
          ? "This post's task is waiting for review, so its person can't change now."
          : "This post's task is completed, so its person can't change." });
      }
      const fmt = linked[0]?.content_format_id ?? await postTaskFormat(req.orgId, p.postType ?? prior.post_type);
      const who = await personError(req, p.editorId || null, prior.editor_id ?? null, fmt);
      if (who) return res.status(who.status).json({ error: who.error });
    }

    // Its task follows the task board's rules: its title and due date change
    // only for someone who may re-plan it there (an admin, whoever gave it, or
    // its person on a task they made for themselves) — otherwise the post moves
    // and the task keeps them; and only they move it to someone else.
    let keepBrief = false;
    const reDated = prior && ((p.date !== undefined && (p.date || null) !== (prior.date ?? null)) || (p.title !== undefined && p.title !== prior.title));
    const rePersoned = prior && p.editorId !== undefined && (p.editorId || null) !== (prior.editor_id ?? null);
    if (req.role !== "admin" && (reDated || rePersoned)) {
      const { rows: lt } = await pool.query("select editor_id, created_by, assigned_by, status from task where post_id = $1", [req.params.id]);
      const t = lt[0];
      if (t && t.status !== "review" && t.status !== "done") {
        const me = await callerEditorId(req);
        // tasks made before Echo noted who set them up: as before (Assign tasks)
        const legacy = !t.created_by && !t.assigned_by;
        const mine = !!me && t.editor_id === me && t.created_by === req.user.sub && !t.assigned_by;
        const mayReplan = mine || ((await canAssignTasks(req)) && (legacy || setUpBy(t, req.user.sub)));
        if (rePersoned && t.editor_id && !legacy && !mayReplan) {
          return res.status(403).json({ error: t.editor_id === me
            ? "This post's task was given to you. To pass it on, use Hand over."
            : "You can move only work you assigned. Ask whoever assigned it, or an admin." });
        }
        keepBrief = !mayReplan;
      }
    }

    const { rows } = await pool.query(
      `update post set ${sets.join(", ")}
       where id = $1 and workspace_id = $2 and deleted_at is null
       returning ${POST_COLUMNS}`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: "Post not found" });
    // Keep the linked task in sync (e.g. editor assigned/changed on edit).
    await syncPostTask(req.params.id, req.orgId, req.user.sub, { keepBrief });

    const post = rows[0];
    if (prior && prior.status !== "published" && post.status === "published") {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "published",
        entityType: "post", entityId: post.id, channelId: post.workspace_id ?? prior.workspace_id,
        summary: `Published “${post.title}”`,
      });
    } else if (prior && prior.edit_stage !== "completed" && post.edit_stage === "completed") {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "stage_completed",
        entityType: "post", entityId: post.id, channelId: post.workspace_id ?? prior.workspace_id,
        summary: `Marked “${post.title}” editing complete`,
      });
    }
    res.json({ post });
  } catch (err) {
    next(err);
  }
});

postsRouter.delete("/posts/:id", requireEditor, requirePage("posts"), async (req, res, next) => {
  try {
    // Permanent removal (the DELETE is recorded in audit_log by trigger).
    const { rowCount } = await pool.query(
      "delete from post where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (rowCount === 0) return res.status(404).json({ error: "Post not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
