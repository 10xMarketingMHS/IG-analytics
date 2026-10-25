import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { requireActiveEod } from "./eod.js";
import { mayOpenTask, taskViewer } from "../hierarchy.js";
import { logActivity } from "../activity.js";
import { hasColumn } from "../schema-flags.js";
import { validYmd } from "../leave-math.js";
import { callerEditorId, nextBrandTaskRef, nextTaskRef, taskSelect } from "./tasks.js";
import {
  LINK_AFTER_DAYS, NEEDS_SCHED_DB, addDaysYmd, isScheduler, sameLink, scheduleFormat, scheduleStage, schedulerIds, schedulingReady,
} from "../scheduling.js";

// Scheduling approved Social tasks (../scheduling.js). The schedulers — anyone
// with a Schedule goal this month — share one list; whoever sets a task's post
// date takes it (it leaves the others' list). They post it and paste each
// platform's link: each becomes a post with the task's brand, title, date and
// editor, on the same SID, and the scheduling counts as one Schedule job of
// theirs (a completed Schedule task, made once). The leads — Managers, Asst.
// Managers and Team Leads by position (Team › Roster), and the Super Admin —
// see everyone's, may do any of it, and hand a task to another scheduler.
// Nobody else sees Scheduling, admins included.
//   GET   /scheduling/access     may the caller see the list (the sidebar's Scheduling)
//   GET   /scheduling            the list: the shared one, and what the caller took
//   GET   /tasks/:id/schedule    where one task stands, what can be done
//   PATCH /tasks/:id/schedule    { postOn, postTime, schedulerId }
//   POST  /tasks/:id/links       { links: [{ platformId, url }], pillarId, contentTypeId, formatId, avatarId }
export const schedulingRouter = Router();

const REF = "coalesce(t.sid, t.tid)";
const dayWords = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const clockWords = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };

// who's asking: their roster id, a lead or not (Team Lead or above: the
// hierarchy's rank 0–2, or the Super Admin), a scheduler this month or not
async function who(req) {
  const [me, viewer] = await Promise.all([callerEditorId(req), taskViewer(req)]);
  return { me, lead: viewer.seesAll || viewer.rank <= 2, scheduler: await isScheduler(req.orgId, me) };
}

async function taskRow(orgId, taskId) {
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.task_type, t.post_id, t.channel_id, t.editor_id, t.scheduler_id, t.schedule_from,
            t.post_on::text as post_on, to_char(t.post_time, 'HH24:MI') as post_time, ${REF} as ref, se.name as scheduler_name
       from task t left join editor se on se.id = t.scheduler_id
      where t.id = $1 and t.org_id = $2`,
    [taskId, orgId],
  );
  return rows[0] ?? null;
}
// a task in scheduling may be opened by the schedulers, whoever's work it was
async function mayOpen(req, t, w) {
  return (!!t.schedule_from && (w.lead || w.scheduler || w.me === t.scheduler_id)) || (await mayOpenTask(req, t.id));
}
const canAct = (t, w) => !!t.schedule_from && t.status === "done" && (w.lead || (!!w.me && w.me === t.scheduler_id) || (!t.scheduler_id && w.scheduler));

// Where a task stands in scheduling and what the caller may do there.
async function scheduleView(req, t, w) {
  const [posts, platforms, schedulers] = await Promise.all([
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
    w.lead ? schedulerIds(req.orgId).then(async (ids) => (ids.length
      ? (await pool.query("select id, name from editor where id = any($1::uuid[]) order by name", [ids])).rows : [])) : [],
  ]);
  const canSchedule = canAct(t, w);
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
    schedulerId: t.scheduler_id, schedulerName: t.scheduler_name, mine: !!w.me && w.me === t.scheduler_id,
    postOn: t.post_on, postTime: t.post_time,
    linksDueOn: t.post_on ? addDaysYmd(t.post_on, LINK_AFTER_DAYS) : null,
    canSchedule, canChangeScheduler: !!t.schedule_from && t.status === "done" && w.lead,
    schedulers, platforms: platforms.rows, posts: posts.rows, defaults,
  };
}

schedulingRouter.get("/scheduling/access", async (req, res, next) => {
  try {
    if (!(await schedulingReady())) return res.json({ allowed: false, scheduler: false });
    const w = await who(req);
    res.json({ allowed: w.lead || w.scheduler, scheduler: w.scheduler });
  } catch (err) { next(err); }
});

// The list: everything waiting in the shared list, what the caller took (a
// lead: everyone's), and what went live in the last 60 days.
schedulingRouter.get("/scheduling", async (req, res, next) => {
  try {
    if (!(await schedulingReady())) return res.status(409).json({ error: NEEDS_SCHED_DB });
    const w = await who(req);
    if (!w.lead && !w.scheduler) return res.status(403).json({ error: "Scheduling is for the people with a Schedule goal this month." });
    const { rows } = await pool.query(
      `${await taskSelect()}
        where t.org_id = $1 and t.status = 'done' and t.schedule_from is not null
          and ($2::boolean or t.scheduler_id is null or t.scheduler_id = $3::uuid)
          and (not exists (select 1 from post fp where fp.from_task_id = t.id and fp.deleted_at is null)
               or t.schedule_from > now() - interval '60 days')
        order by t.post_on nulls first, t.schedule_from`,
      [req.orgId, w.lead, w.me],
    );
    res.json({ tasks: rows, me: w.me, lead: w.lead, scheduler: w.scheduler });
  } catch (err) { next(err); }
});

schedulingRouter.get("/tasks/:id/schedule", async (req, res, next) => {
  try {
    if (!(await schedulingReady())) return res.json({ ready: false });
    const t = await taskRow(req.orgId, req.params.id);
    const w = t && (await who(req));
    if (!t || !(await mayOpen(req, t, w))) return res.status(404).json({ error: "Task not found." });
    res.json(await scheduleView(req, t, w));
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
    const w = await who(req);
    if (!canAct(t, w)) {
      return res.status(403).json({ error: t.scheduler_id ? `${t.scheduler_name ?? "Another scheduler"} has taken this one.` : "Scheduling is for the people with a Schedule goal this month." });
    }
    const sets = [], params = [req.params.id];
    const push = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    let handedTo = null;
    if (d.schedulerId !== undefined && (d.schedulerId ?? null) !== t.scheduler_id) {
      if (!w.lead) return res.status(403).json({ error: "Only a Manager or Team Lead can hand it to another scheduler." });
      if (d.schedulerId && !(await schedulerIds(req.orgId)).includes(d.schedulerId)) {
        return res.status(400).json({ error: "Pick someone with a Schedule goal this month (Goals › Set goals)." });
      }
      push("scheduler_id", d.schedulerId ?? null);
      handedTo = d.schedulerId ?? null;
    }
    const postOn = d.postOn !== undefined ? d.postOn : t.post_on;
    if (d.postOn !== undefined) {
      push("post_on", d.postOn);
      // setting the date takes it (unless a lead is handing it to someone); clearing it gives it back to the list
      if (d.schedulerId === undefined) {
        if (d.postOn && !t.scheduler_id && w.me) push("scheduler_id", w.me);
        if (!d.postOn && !w.lead) push("scheduler_id", null);
      }
    }
    // a time only goes with a date
    if (d.postTime !== undefined || (d.postOn === null && t.post_time)) push("post_time", postOn ? d.postTime ?? t.post_time ?? null : null);
    if (!sets.length) return res.json(await scheduleView(req, t, w));
    await pool.query(`update task set ${sets.join(", ")} where id = $1`, params);
    const fresh = await taskRow(req.orgId, req.params.id);
    if (d.postOn !== undefined && fresh.post_on !== t.post_on) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "schedule_set", entityType: "task", entityId: t.id, channelId: t.channel_id,
        summary: fresh.post_on
          ? `Set ${t.ref} “${t.title}” to post on ${dayWords(fresh.post_on)}${fresh.post_time ? `, ${clockWords(fresh.post_time)}` : ""}`
          : `Put ${t.ref} “${t.title}” back in the scheduling list`,
        meta: { postOn: fresh.post_on },
      });
    }
    if (handedTo) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "schedule_ready", entityType: "task", entityId: t.id, channelId: t.channel_id,
        summary: `${t.ref} “${t.title}” is yours to schedule`,
        meta: { notifyEditorIds: [handedTo] },
      });
    }
    res.json(await scheduleView(req, fresh, w));
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

// The scheduling, as one Schedule job of the scheduler's: a completed task of
// the org's Schedule type, made once per scheduled task, when its links go in —
// so it counts in their goal, points and the Leaderboard like any other job.
async function creditSchedule(orgId, t, schedulerId, userId) {
  const fmt = await scheduleFormat(orgId);
  if (!fmt || !schedulerId) return null;
  const { rowCount } = await pool.query("select 1 from task where org_id = $1 and meta->>'schedulesTaskId' = $2", [orgId, t.id]);
  if (rowCount) return null;
  const category = fmt.category ?? "service";
  const kind = { social: ["sid", "sid"], ad: ["adid", "ad_id"], service: ["svid", "svid"], project: ["pid", "pid"] }[category] ?? ["svid", "svid"];
  const [tid, brandRef] = await Promise.all([nextTaskRef(orgId, "tid"), t.channel_id ? nextBrandTaskRef(t.channel_id, kind[0]) : null]);
  const frozen = await hasColumn("task", "points_at_done");
  const { rows } = await pool.query(
    `insert into task (org_id, editor_id, channel_id, title, description, status, priority, task_type, accepted, content_format_id,
                       due_date, completed_at, tid, ${kind[1]}, created_by, meta${frozen ? ", points_at_done" : ""})
     values ($1, $2, $3, $4, $5, 'done', 'medium', $6, true, $7, (now() at time zone 'Asia/Kolkata')::date, now(), $8, $9, $10, $11${frozen ? ", $12" : ""})
     returning id`,
    [orgId, schedulerId, t.channel_id, `Scheduled ${t.ref} “${t.title}”`,
      `Made by Echo when ${t.ref}'s links went in: the scheduling of it, as one ${fmt.name} job.`,
      category, fmt.id, tid, brandRef, userId, JSON.stringify({ schedulesTaskId: t.id }), ...(frozen ? [fmt.points] : [])],
  );
  return rows[0]?.id ?? null;
}

schedulingRouter.post("/tasks/:id/links", requireEditor, requireActiveEod, async (req, res, next) => {
  const parsed = LinksSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  const d = parsed.data;
  try {
    if (!(await schedulingReady())) return res.status(409).json({ error: NEEDS_SCHED_DB });
    let t = await taskRow(req.orgId, req.params.id);
    if (!t) return res.status(404).json({ error: "Task not found." });
    if (!t.schedule_from || t.status !== "done" || !t.channel_id) return res.status(409).json({ error: "This task isn't waiting for its links." });
    const w = await who(req);
    if (!canAct(t, w)) {
      return res.status(403).json({ error: t.scheduler_id ? `${t.scheduler_name ?? "Another scheduler"} has taken this one.` : "Scheduling is for the people with a Schedule goal this month." });
    }
    // one link per platform, each a platform this brand posts on, and not one it has already
    const view = await scheduleView(req, t, w);
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
    const { rows: dup } = await pool.query(
      `select p.title from post p join workspace w on w.id = p.workspace_id
        where w.org_id = $1 and p.deleted_at is null and p.permalink is not null
          and regexp_replace(regexp_replace(lower(trim(p.permalink)), '[?#].*$', ''), '/+$', '') = any($2::text[]) limit 1`,
      [req.orgId, d.links.map((l) => sameLink(l.url))],
    );
    if (dup.length) return res.status(409).json({ error: `That link is already on the post “${dup[0].title}”.` });

    // linking it takes it, when it wasn't taken yet
    if (!t.scheduler_id && w.me) {
      await pool.query("update task set scheduler_id = $2 where id = $1 and scheduler_id is null", [t.id, w.me]);
      t = await taskRow(req.orgId, req.params.id);
    }
    const date = t.post_on ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
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
    await creditSchedule(req.orgId, t, t.scheduler_id, req.user.sub);
    const names = d.links.map((l) => brandPlat.get(l.platformId)?.name).filter(Boolean);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "schedule_linked", entityType: "task", entityId: t.id, channelId: t.channel_id,
      summary: `Posted ${t.ref} “${t.title}” on ${names.join(" and ")}`,
      meta: { platforms: names, notifyEditorIds: [t.editor_id].filter(Boolean) },
    });
    res.status(201).json(await scheduleView(req, t, w));
  } catch (err) { next(err); }
});
