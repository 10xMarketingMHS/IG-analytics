import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";
import { requireActiveEod } from "./eod.js";
import { logActivity } from "../activity.js";
import { isOrgAdmin } from "../permissions.js";
import { resolveBudgetHours } from "./tasks.js";
import { editorRanks, seesEditor, taskViewer } from "../hierarchy.js";
import { hasColumn } from "../schema-flags.js";
import { coverFrom } from "../goal-score.js";
import { LEVEL_LABEL, handoverPeople, handoverReady, leadsAndManagers, pauseForHandover, resumeAfterHandover, syncHandovers } from "../handover.js";

// Hand over (see ../handover.js): offer your own task to a teammate; they
// accept or decline; you can call it off; once it has climbed to someone,
// they can move it to whoever should do it.
export const handoverRouter = Router();

async function caller(req) {
  const { rows } = await pool.query(
    "select u.editor_id, e.name from app_user u left join editor e on e.id = u.editor_id where u.id = $1",
    [req.user.sub],
  );
  const admin = req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
  return { editorId: rows[0]?.editor_id ?? null, name: rows[0]?.name ?? null, admin };
}
const notReady = (res) => res.status(503).json({ error: "Hand over isn't set up on this server yet." });

// A hand-over with what its task looks like now.
async function load(req, id) {
  const { rows } = await pool.query(
    `select h.*, t.title, t.channel_id, t.status as task_status, t.content_format_id, t.editor_id as task_editor_id,
            ef.name as from_name, et.name as to_name
       from task_handover h
       join task t on t.id = h.task_id
       left join editor ef on ef.id = h.from_editor_id
       left join editor et on et.id = h.to_editor_id
      where h.id = $1 and h.org_id = $2`,
    [id, req.orgId],
  );
  return rows[0] ?? null;
}

// The task becomes someone else's: their time budget, a fresh clock (running
// only if they've accepted it and it's under way), no hold, no rework note.
async function giveTask(orgId, h, editorId, accepted, assignedBy) {
  const budget = await resolveBudgetHours(orgId, editorId, h.content_format_id);
  const startAt = accepted && budget != null && h.task_status === "in_progress" ? new Date() : null;
  const params = [h.task_id, editorId, accepted, budget, startAt];
  const extra = [];
  if (assignedBy !== undefined) { params.push(assignedBy); extra.push(`assigned_by = $${params.length}`); }
  // It's covered work for its new person: taken over from its owner (or from
  // whoever it first belonged to), unless it's going back to them. Only work
  // someone was given counts as covered: a task its owner made for themselves
  // stays self-made for whoever takes it (counted up to the goal, never on top).
  if (await hasColumn("task", "covered_from_editor_id")) {
    const cur = (await pool.query("select covered_from_editor_id, assigned_by from task where id = $1", [h.task_id])).rows[0] ?? {};
    const given = !!cur.covered_from_editor_id || !!cur.assigned_by;
    params.push(given ? coverFrom(cur.covered_from_editor_id ?? null, h.from_editor_id, editorId) : null);
    extra.push(`covered_from_editor_id = $${params.length}`);
  }
  await pool.query(
    `update task
        set editor_id = $2, accepted = $3, on_hold = false, held_by = null, pending_note = null,
            budget_hours = $4,
            -- the time already spent stays on the task: carried in the clock when it runs on, kept as banked time when it doesn't
            budget_used_seconds = case when $5::timestamptz is null then coalesce(budget_used_seconds, 0) else 0 end,
            budget_started_at = case when $5::timestamptz is null then null
                                     else $5::timestamptz - make_interval(secs => coalesce(budget_used_seconds, 0)) end
            ${extra.length ? ", " + extra.join(", ") : ""}
      where id = $1`,
    params,
  );
}

async function answer(id, status, userId, note = null) {
  await pool.query(
    "update task_handover set status = $2, answered_by = $3, answer_note = $4, answered_at = now() where id = $1",
    [id, status, userId, note],
  );
}

// What's waiting that concerns you: hand-overs you offered, ones offered to
// you, and ones that have climbed to you (admins also see the rest, from people
// at their level or below; the Super Admin all), plus who you could hand a task to.
handoverRouter.get("/handovers", async (req, res, next) => {
  try {
    if (!(await handoverReady())) return res.json({ ready: false, people: [], items: [] });
    // the climb is checked at most once a minute, in the background (shows on the next look)
    syncHandovers(req.orgId).catch(() => {});
    const [who, viewer, ranks] = await Promise.all([caller(req), taskViewer(req), editorRanks(req.orgId)]);
    const { rows: found } = await pool.query(
      `select h.id, h.task_id as "taskId", t.title as "taskTitle", t.status as "taskStatus",
              -- the number the board shows (pages/tasks.tsx taskRef)
              coalesce(t.sid, regexp_replace(t.ad_id, '^AdID', 'AID', 'i'), t.svid, t.pid, t.tid) as "taskRef",
              h.from_editor_id as "fromEditorId", ef.name as "fromName", ef.image_url as "fromImage",
              h.to_editor_id as "toEditorId", et.name as "toName", et.image_url as "toImage",
              h.note, h.level, h.reached, h.created_at as "createdAt", h.escalated_at as "escalatedAt"
         from task_handover h
         join task t on t.id = h.task_id
         left join editor ef on ef.id = h.from_editor_id
         left join editor et on et.id = h.to_editor_id
        where h.org_id = $1 and h.status = 'pending'
          and ($2::boolean or h.from_editor_id = $3::uuid or h.to_editor_id = $3::uuid or $3::uuid = any(h.reached))
        order by h.created_at`,
      [req.orgId, who.admin, who.editorId],
    );
    // an admin's wider view stops at people above them
    const rows = found.filter((r) => r.fromEditorId === who.editorId || r.toEditorId === who.editorId
      || (r.reached ?? []).includes(who.editorId) || seesEditor(viewer, ranks, r.fromEditorId));
    const items = rows.map(({ reached, ...r }) => ({
      ...r,
      mine: r.fromEditorId && r.fromEditorId === who.editorId ? "from" : r.toEditorId && r.toEditorId === who.editorId ? "to" : "reached",
      canMove: who.admin || (!!who.editorId && (reached ?? []).includes(who.editorId)),
      reachedLabel: LEVEL_LABEL[r.level] ?? null,
    }));
    // who you can hand to or move to: never people above you (the Super Admin: anyone)
    const people = (await handoverPeople(req.orgId))
      .filter((p) => p.id !== who.editorId && seesEditor(viewer, ranks, p.id))
      .map(({ id, name, designation, imageUrl }) => ({ id, name, designation, imageUrl }));
    res.json({ ready: true, people, items });
  } catch (err) {
    next(err);
  }
});

const OfferSchema = z.object({
  toEditorId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});

// Offer your own task (accepted, in To Do or In Progress) to a teammate.
handoverRouter.post("/tasks/:id/handover", requireEditor, async (req, res, next) => {
  const parsed = OfferSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick who to hand it to." });
  try {
    if (!(await handoverReady())) return notReady(res);
    const who = await caller(req);
    const t = (await pool.query(
      "select id, title, channel_id, editor_id, status, accepted, on_hold, budget_hours, budget_started_at, budget_used_seconds from task where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    )).rows[0];
    if (!t) return res.status(404).json({ error: "Task not found" });
    if (!who.editorId || t.editor_id !== who.editorId) return res.status(403).json({ error: "You can hand over only your own tasks." });
    if (!t.accepted) return res.status(400).json({ error: "Accept this task first, then you can hand it over." });
    if (t.status !== "todo" && t.status !== "in_progress") {
      return res.status(400).json({ error: "Only a task in To Do or In Progress can be handed over." });
    }
    const to = parsed.data.toEditorId;
    if (to === who.editorId) return res.status(400).json({ error: "Pick someone other than yourself." });
    const person = (await handoverPeople(req.orgId)).find((p) => p.id === to);
    if (!person) return res.status(400).json({ error: "That person can't take tasks yet. They need an active login on the team." });
    const waiting = await pool.query("select 1 from task_handover where task_id = $1 and status = 'pending'", [t.id]);
    if (waiting.rowCount) return res.status(409).json({ error: "This task is already waiting on a hand-over." });

    const paused = await pauseForHandover(t, req.user.sub);
    const { rows } = await pool.query(
      `insert into task_handover (org_id, task_id, from_editor_id, to_editor_id, offered_by, note, paused)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [req.orgId, t.id, who.editorId, to, req.user.sub, parsed.data.note || null, paused],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "handover_offered", entityType: "task", entityId: t.id, channelId: t.channel_id,
      summary: `Wants to hand over “${t.title}” to ${person.name}${parsed.data.note ? `: ${parsed.data.note}` : ""}`,
      // the teammate, plus every Team Lead and Manager
      meta: { handoverId: rows[0].id, notifyEditorIds: [...new Set([to, ...(await leadsAndManagers(req.orgId))])].filter((x) => x !== who.editorId) },
    });
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "This task is already waiting on a hand-over." });
    next(err);
  }
});

// The teammate takes it: it's theirs now (and so are its points).
handoverRouter.post("/handovers/:id/accept", requireEditor, requireActiveEod, async (req, res, next) => {
  try {
    if (!(await handoverReady())) return notReady(res);
    const h = await load(req, req.params.id);
    if (!h) return res.status(404).json({ error: "Hand-over not found" });
    if (h.status !== "pending") return res.status(409).json({ error: "This hand-over has already been answered." });
    const who = await caller(req);
    if (!who.editorId || who.editorId !== h.to_editor_id) return res.status(403).json({ error: "Only the person it was handed to can accept it." });
    if (h.task_editor_id !== h.from_editor_id) {
      await answer(h.id, "cancelled", req.user.sub);
      return res.status(409).json({ error: "This task has already moved on." });
    }
    await giveTask(req.orgId, h, h.to_editor_id, true, undefined);
    await answer(h.id, "accepted", req.user.sub);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "handover_accepted", entityType: "task", entityId: h.task_id, channelId: h.channel_id,
      summary: `Took over “${h.title}” from ${h.from_name ?? "a teammate"}`,
      // the owner, plus every Team Lead and Manager
      meta: { handoverId: h.id, notifyEditorIds: [...new Set([h.from_editor_id, ...(await leadsAndManagers(req.orgId))])].filter((x) => x && x !== who.editorId) },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const NoteSchema = z.object({ note: z.string().trim().max(500).optional() });

// The teammate says no: it stays with its owner, whose timer runs on.
handoverRouter.post("/handovers/:id/decline", requireEditor, async (req, res, next) => {
  const parsed = NoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That note is too long." });
  try {
    if (!(await handoverReady())) return notReady(res);
    const h = await load(req, req.params.id);
    if (!h) return res.status(404).json({ error: "Hand-over not found" });
    if (h.status !== "pending") return res.status(409).json({ error: "This hand-over has already been answered." });
    const who = await caller(req);
    if (!who.editorId || who.editorId !== h.to_editor_id) return res.status(403).json({ error: "Only the person it was handed to can decline it." });
    if (h.paused) await resumeAfterHandover(h.task_id);
    const note = parsed.data.note || null;
    await answer(h.id, "declined", req.user.sub, note);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "handover_declined", entityType: "task", entityId: h.task_id, channelId: h.channel_id,
      summary: `Declined “${h.title}”, so it stays with ${h.from_name ?? "its owner"}${note ? `: ${note}` : ""}`,
      meta: { handoverId: h.id, notifyEditorIds: [h.from_editor_id].filter(Boolean) },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// The owner (or an admin) calls it off before it's answered.
handoverRouter.post("/handovers/:id/cancel", requireEditor, async (req, res, next) => {
  try {
    if (!(await handoverReady())) return notReady(res);
    const h = await load(req, req.params.id);
    if (!h) return res.status(404).json({ error: "Hand-over not found" });
    if (h.status !== "pending") return res.status(409).json({ error: "This hand-over has already been answered." });
    const who = await caller(req);
    const own = !!who.editorId && who.editorId === h.from_editor_id;
    if (!own && !(who.admin && seesEditor(await taskViewer(req), await editorRanks(req.orgId), h.from_editor_id))) {
      return res.status(403).json({ error: "Only the task's owner can call off its hand-over." });
    }
    if (h.paused) await resumeAfterHandover(h.task_id);
    await answer(h.id, "cancelled", req.user.sub);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "handover_cancelled", entityType: "task", entityId: h.task_id, channelId: h.channel_id,
      summary: `Called off handing over “${h.title}” to ${h.to_name ?? "a teammate"}`,
      meta: { handoverId: h.id, notifyEditorIds: [h.to_editor_id].filter(Boolean) },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const MoveSchema = z.object({ toEditorId: z.string().uuid() });

// Someone it has climbed to (or an admin) gives it to whoever should do it.
// That person accepts it like any assigned task.
handoverRouter.post("/handovers/:id/move", requireEditor, async (req, res, next) => {
  const parsed = MoveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick who should do it." });
  try {
    if (!(await handoverReady())) return notReady(res);
    const h = await load(req, req.params.id);
    if (!h) return res.status(404).json({ error: "Hand-over not found" });
    if (h.status !== "pending") return res.status(409).json({ error: "This hand-over has already been answered." });
    const who = await caller(req);
    const reachedMe = !!who.editorId && (h.reached ?? []).includes(who.editorId);
    const [viewer, ranks] = await Promise.all([taskViewer(req), editorRanks(req.orgId)]);
    if (!reachedMe && !(who.admin && seesEditor(viewer, ranks, h.from_editor_id))) {
      return res.status(403).json({ error: "This hand-over hasn't come to you." });
    }
    const to = parsed.data.toEditorId;
    if (to !== who.editorId && !seesEditor(viewer, ranks, to)) {
      return res.status(403).json({ error: "You can't move a task to someone above you." });
    }
    const person = (await handoverPeople(req.orgId)).find((p) => p.id === to);
    if (!person) return res.status(400).json({ error: "That person can't take tasks yet. They need an active login on the team." });
    const toSelf = to === who.editorId;
    await giveTask(req.orgId, h, to, toSelf, toSelf ? null : req.user.sub);
    await answer(h.id, "moved", req.user.sub);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "handover_moved", entityType: "task", entityId: h.task_id, channelId: h.channel_id,
      summary: `${toSelf ? `Took over “${h.title}”` : `Moved “${h.title}” to ${person.name}`} (${h.to_name ?? "the teammate"} hadn't accepted it from ${h.from_name ?? "its owner"})`,
      meta: { handoverId: h.id, toEditorId: to, notifyEditorIds: [...new Set([h.from_editor_id, h.to_editor_id, to].filter((x) => x && x !== who.editorId))] },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
