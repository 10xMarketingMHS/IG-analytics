import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { requireActiveEod } from "./eod.js";
import { isOrgAdmin, requirePermission } from "../permissions.js";
import { mayOpenTask } from "../hierarchy.js";
import { logActivity } from "../activity.js";
import { istNow } from "../attendance.js";
import { validYmd } from "../leave-math.js";
import { callerEditorId } from "./tasks.js";
import { LINK_AFTER_DAYS, NEEDS_SCHED_DB, addDaysYmd, sameLink, scheduleStage, schedulingReady } from "../scheduling.js";

// Scheduling an approved Social task (../scheduling.js): its scheduler (the
// brand's, Settings › Channels) sets the post date, posts it, and pastes each
// platform's link — each becomes a post with the task's brand, title, date and
// editor, on the same SID. An admin may do it for them, or change who it is.
//   GET   /tasks/:id/schedule      where it stands, what can be done
//   PATCH /tasks/:id/schedule      { postOn, postTime, schedulerId }
//   POST  /tasks/:id/links         { links: [{ platformId, url }], pillarId, contentTypeId, formatId, avatarId }
//   PUT   /workspaces/:id/scheduler { editorId } — a brand's scheduler (Settings › Channels)
export const schedulingRouter = Router();

const REF = "coalesce(t.sid, t.tid)";
const isAdmin = async (req) => req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
// a scheduler signs in to Echo to set dates and paste links: on this team, with a login
async function canBeScheduler(orgId, editorId) {
  const { rowCount } = await pool.query(
    "select 1 from editor e join app_user u on u.editor_id = e.id and u.active where e.id = $1 and e.org_id = $2 and e.active",
    [editorId, orgId],
  );
  return rowCount > 0;
}
const dayWords = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const clockWords = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };

async function taskRow(orgId, taskId) {
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.task_type, t.post_id, t.channel_id, t.editor_id, t.scheduler_id, t.schedule_from,
            t.post_on::text as post_on, to_char(t.post_time, 'HH24:MI') as post_time, ${REF} as ref,
            se.name as scheduler_name, w.scheduler_id as brand_scheduler_id, bw.name as brand_scheduler_name
       from task t
       left join editor se on se.id = t.scheduler_id
       left join workspace w on w.id = t.channel_id
       left join editor bw on bw.id = w.scheduler_id
      where t.id = $1 and t.org_id = $2`,
    [taskId, orgId],
  );
  return rows[0] ?? null;
}

// Where a task stands in scheduling and what the caller may do there.
async function scheduleView(req, t) {
  const [posts, platforms, me, admin] = await Promise.all([
    pool.query(
      `select p.id, p.platform_id as "platformId", pl.key as "platformKey", pl.name as "platformName", p.permalink,
              p.date::text as date, p.views, p.saves, p.metrics_updated_at as "metricsUpdatedAt"
         from post p left join platform pl on pl.id = p.platform_id
        where p.from_task_id = $1 and p.deleted_at is null order by pl.sort_order`,
      [t.id],
    ),
    t.channel_id
      ? pool.query(
        `select a.platform_id as "platformId", pl.key, pl.name from account a join platform pl on pl.id = a.platform_id
          where a.workspace_id = $1 and a.active and pl.active order by pl.sort_order`,
        [t.channel_id],
      )
      : { rows: [] },
    callerEditorId(req),
    isAdmin(req),
  ]);
  const open = !!t.schedule_from && t.status === "done";
  const canSchedule = open && (admin || (!!me && me === t.scheduler_id));
  // the details the last post took, to start the link form from: yours on this brand first, else its latest
  const defaults = canSchedule && t.channel_id ? (await pool.query(
    `select pillar_id as "pillarId", content_type_id as "contentTypeId", format_id as "formatId", avatar_id as "avatarId"
       from post where workspace_id = $1 and deleted_at is null and not is_collab_mirror
      order by (created_by = $2) desc, created_at desc limit 1`,
    [t.channel_id, req.user.sub],
  )).rows[0] ?? null : null;
  return {
    ready: true,
    inFlow: !!t.schedule_from,
    stage: scheduleStage({ ...t, linked_posts: posts.rows.length }),
    schedulerId: t.scheduler_id, schedulerName: t.scheduler_name,
    brandSchedulerId: t.brand_scheduler_id, brandSchedulerName: t.brand_scheduler_name,
    postOn: t.post_on, postTime: t.post_time,
    linksDueOn: t.post_on ? addDaysYmd(t.post_on, LINK_AFTER_DAYS) : null,
    canSchedule, canChangeScheduler: open && admin,
    platforms: platforms.rows, posts: posts.rows, defaults,
  };
}

schedulingRouter.get("/tasks/:id/schedule", async (req, res, next) => {
  try {
    if (!(await schedulingReady())) return res.json({ ready: false });
    const t = await taskRow(req.orgId, req.params.id);
    if (!t || !(await mayOpenTask(req, req.params.id))) return res.status(404).json({ error: "Task not found." });
    res.json(await scheduleView(req, t));
  } catch (err) { next(err); }
});

const ScheduleSchema = z.object({
  postOn: z.string().refine(validYmd, "Pick a date.").nullable().optional(),
  postTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time.").nullable().optional(),
  schedulerId: z.string().uuid().nullable().optional(),
});

schedulingRouter.patch("/tasks/:id/schedule", requireEditor, requireActiveEod, async (req, res, next) => {
  const parsed = ScheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await schedulingReady())) return res.status(409).json({ error: NEEDS_SCHED_DB });
    const t = await taskRow(req.orgId, req.params.id);
    if (!t) return res.status(404).json({ error: "Task not found." });
    if (!t.schedule_from || t.status !== "done") return res.status(409).json({ error: "This task isn't waiting to be scheduled." });
    const d = parsed.data;
    const [me, admin] = await Promise.all([callerEditorId(req), isAdmin(req)]);
    if (!admin && !(me && me === t.scheduler_id)) {
      return res.status(403).json({ error: `Only ${t.scheduler_name ?? "its scheduler"} or an admin can schedule this.` });
    }
    const sets = [], params = [req.params.id];
    const push = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    let newScheduler = null;
    if (d.schedulerId !== undefined && (d.schedulerId ?? null) !== t.scheduler_id) {
      if (!admin) return res.status(403).json({ error: "Only an admin can change who schedules it." });
      if (d.schedulerId && !(await canBeScheduler(req.orgId, d.schedulerId))) {
        return res.status(400).json({ error: "Pick someone on the team with a login: they set the date and paste the links in Echo." });
      }
      push("scheduler_id", d.schedulerId ?? null);
      newScheduler = d.schedulerId ?? null;
    }
    const postOn = d.postOn !== undefined ? d.postOn : t.post_on;
    if (d.postOn !== undefined) push("post_on", d.postOn);
    // a time only goes with a date
    if (d.postTime !== undefined || (d.postOn === null && t.post_time)) push("post_time", postOn ? d.postTime ?? t.post_time ?? null : null);
    if (!sets.length) return res.json(await scheduleView(req, t));
    await pool.query(`update task set ${sets.join(", ")} where id = $1`, params);
    const fresh = await taskRow(req.orgId, req.params.id);
    if (d.postOn !== undefined && fresh.post_on !== t.post_on) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "schedule_set", entityType: "task", entityId: t.id, channelId: t.channel_id,
        summary: fresh.post_on
          ? `Set ${t.ref} “${t.title}” to post on ${dayWords(fresh.post_on)}${fresh.post_time ? `, ${clockWords(fresh.post_time)}` : ""}`
          : `Cleared the post date of ${t.ref} “${t.title}”`,
        meta: { postOn: fresh.post_on, notifyEditorIds: [fresh.scheduler_id].filter(Boolean) },
      });
    }
    if (newScheduler) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "schedule_ready", entityType: "task", entityId: t.id, channelId: t.channel_id,
        summary: `${t.ref} “${t.title}” is yours to schedule`,
        meta: { notifyEditorIds: [newScheduler] },
      });
    }
    res.json(await scheduleView(req, fresh));
  } catch (err) { next(err); }
});

const LinksSchema = z.object({
  links: z.array(z.object({
    platformId: z.string().uuid(),
    url: z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, "Paste the post's link, starting with https://"),
  })).min(1, "Paste at least one link.").max(6),
  pillarId: z.string({ required_error: "Pick a pillar." }).uuid({ message: "Pick a pillar." }),
  contentTypeId: z.string({ required_error: "Pick a content type." }).uuid({ message: "Pick a content type." }),
  formatId: z.string({ required_error: "Pick a format." }).uuid({ message: "Pick a format." }),
  avatarId: z.string({ required_error: "Pick an avatar." }).uuid({ message: "Pick an avatar." }),
});

schedulingRouter.post("/tasks/:id/links", requireEditor, requireActiveEod, async (req, res, next) => {
  const parsed = LinksSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  const d = parsed.data;
  try {
    if (!(await schedulingReady())) return res.status(409).json({ error: NEEDS_SCHED_DB });
    const t = await taskRow(req.orgId, req.params.id);
    if (!t) return res.status(404).json({ error: "Task not found." });
    if (!t.schedule_from || t.status !== "done" || !t.channel_id) return res.status(409).json({ error: "This task isn't waiting for its links." });
    const [me, admin] = await Promise.all([callerEditorId(req), isAdmin(req)]);
    if (!admin && !(me && me === t.scheduler_id)) {
      return res.status(403).json({ error: `Only ${t.scheduler_name ?? "its scheduler"} or an admin can add its links.` });
    }
    // one link per platform, each a platform this brand posts on, and not one it has already
    const view = await scheduleView(req, t);
    const brandPlat = new Map(view.platforms.map((p) => [p.platformId, p]));
    const seen = new Set();
    for (const l of d.links) {
      const p = brandPlat.get(l.platformId);
      if (!p) return res.status(400).json({ error: "That platform isn't one this brand posts on." });
      if (seen.has(l.platformId)) return res.status(400).json({ error: `Only one ${p.name} link, please.` });
      seen.add(l.platformId);
      if (view.posts.some((x) => x.platformId === l.platformId)) return res.status(409).json({ error: `This task already has its ${p.name} link.` });
    }
    // the post's details, from this brand's own lists (a content type sits under its pillar)
    const { rows: [tx] } = await pool.query(
      `select (select 1 from pillar where id = $1 and workspace_id = $5) as pillar,
              (select 1 from content_type where id = $2 and workspace_id = $5 and pillar_id = $1) as ctype,
              (select post_type::text from format where id = $3 and workspace_id = $5) as post_type,
              (select 1 from avatar where id = $4 and workspace_id = $5) as avatar`,
      [d.pillarId, d.contentTypeId, d.formatId, d.avatarId, t.channel_id],
    );
    if (!tx.pillar || !tx.ctype || !tx.post_type || !tx.avatar) {
      return res.status(400).json({ error: "Pick the post's pillar, content type, format and avatar from this brand's lists." });
    }
    // a link already on a post (any brand of this team)
    const wanted = d.links.map((l) => sameLink(l.url));
    const { rows: dup } = await pool.query(
      `select p.title from post p join workspace w on w.id = p.workspace_id
        where w.org_id = $1 and p.deleted_at is null and p.permalink is not null
          and regexp_replace(regexp_replace(lower(trim(p.permalink)), '[?#].*$', ''), '/+$', '') = any($2::text[]) limit 1`,
      [req.orgId, wanted],
    );
    if (dup.length) return res.status(409).json({ error: `That link is already on the post “${dup[0].title}”.` });

    const date = t.post_on ?? istNow().ymd;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const l of d.links) {
        await client.query(
          `insert into post (workspace_id, date, title, pillar_id, content_type_id, format_id, avatar_id, editor_id, post_type,
                             status, published_at, permalink, created_by, platform_id, edit_stage, source, from_task_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', now(), $10, $11, $12, 'completed', 'manual', $13)`,
          [t.channel_id, date, t.title, d.pillarId, d.contentTypeId, d.formatId, d.avatarId, t.editor_id, tx.post_type,
            l.url.trim(), req.user.sub, l.platformId, t.id],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    const names = d.links.map((l) => brandPlat.get(l.platformId)?.name).filter(Boolean);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "schedule_linked", entityType: "task", entityId: t.id, channelId: t.channel_id,
      summary: `Posted ${t.ref} “${t.title}” on ${names.join(" and ")}`,
      meta: { platforms: names, notifyEditorIds: [t.editor_id].filter(Boolean) },
    });
    res.status(201).json(await scheduleView(req, t));
  } catch (err) { next(err); }
});

// A brand's scheduler — Settings › Channels. Its approved social tasks go to them from then on.
schedulingRouter.put("/workspaces/:id/scheduler", requirePermission("channels"), async (req, res, next) => {
  const parsed = z.object({ editorId: z.string().uuid().nullable() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick a person, or none." });
  try {
    if (!(await schedulingReady())) return res.status(409).json({ error: NEEDS_SCHED_DB });
    const { editorId } = parsed.data;
    if (editorId && !(await canBeScheduler(req.orgId, editorId))) {
      return res.status(400).json({ error: "Pick someone on the team with a login: they set the date and paste the links in Echo." });
    }
    const { rows } = await pool.query(
      "update workspace set scheduler_id = $1, updated_at = now() where id = $2 and org_id = $3 returning id, name, scheduler_id",
      [editorId, req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: "Channel not found." });
    res.json({ workspace: rows[0] });
  } catch (err) { next(err); }
});
