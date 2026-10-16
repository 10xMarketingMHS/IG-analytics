import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { logActivity } from "../activity.js";
import { closeStaleSessions } from "./eod.js";

// Start of Day (SOD): after Start Work, an employee adds the day's tasks on the
// board as usual, then opens the Start of Day window on My Day: their open tasks,
// ticked for today or not, and a report to copy for WhatsApp — the morning twin
// of the End of Day report. Copying also saves that list as today's SOD (a
// snapshot; copying again replaces it), so the admin sees it on the Work Day
// page and the End of Day summary can compare it with what got done. Nothing is
// locked behind it.
export const sodRouter = Router();

async function callerEditorId(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}

// The employee's open tasks, sorted into the Start of Day window's groups:
//   added — created by them today
//   today — due today or late, in progress, sent back, or waiting for Accept
//   later — everything else still open
// "suggested" is the starting tick: work clearly for today (added today, due
// today, in progress, sent back) — not old overdue or not-yet-accepted tasks,
// nor ones due later. Tasks waiting in Review are left out: that's the
// reviewer's move, not theirs.
async function planCandidates(orgId, editorId, userId) {
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.accepted, t.pending_note, t.on_hold, t.due_date,
            cf.name as format, w.name as channel,
            (t.created_by = $3 and t.created_at::date = current_date) as "addedToday",
            (current_date - t.due_date) as "daysLate"
       from task t
       left join task_content_format cf on cf.id = t.content_format_id
       left join workspace w on w.id = t.channel_id
      where t.org_id = $1 and t.editor_id = $2 and t.status not in ('done', 'review')
      order by t.due_date nulls last, t.created_at`,
    [orgId, editorId, userId],
  );
  return rows.map((t) => {
    const reasons = [];
    if (t.pending_note) reasons.push("sent back");
    else if (!t.accepted) reasons.push("not accepted yet");
    else if (t.status === "in_progress") reasons.push("in progress");
    if (t.on_hold) reasons.push("on hold");
    if (t.daysLate > 0) reasons.push(`${t.daysLate} day${t.daysLate === 1 ? "" : "s"} late`);
    else if (t.daysLate === 0) reasons.push("due today");
    const onPlate = (t.daysLate != null && t.daysLate >= 0) || t.status === "in_progress" || !t.accepted || !!t.pending_note;
    const group = t.addedToday ? "added" : onPlate ? "today" : "later";
    if (t.daysLate != null && t.daysLate < 0) reasons.push(`due ${t.due_date}`);
    const suggested = t.addedToday || t.daysLate === 0 || !!t.pending_note || (t.status === "in_progress" && !t.on_hold);
    return { id: t.id, title: t.title, format: t.format, channel: t.channel, dueDate: t.due_date, status: t.status, group, reason: reasons.join(", "), suggested };
  });
}

// One person's plan for a date (today when date is null), with when they started.
async function planFor(orgId, editorId, date) {
  const { rows } = await pool.query(
    `select p.id, p.date, p.submitted_at as "submittedAt", p.note, p.tasks,
            e.name as "editorName",
            (select min(s.started_at) from eod_session s
              where s.editor_id = p.editor_id and s.date = p.date) as "startedAt"
       from sod_plan p
       join editor e on e.id = p.editor_id
      where p.org_id = $1 and p.editor_id = $2 and p.date = coalesce($3::date, current_date)`,
    [orgId, editorId, date],
  );
  return rows[0] ?? null;
}

// The caller's Start of Day: today's saved SOD (if copied yet), when they
// started work, and their open tasks for the window. "required" is always
// false — kept so a page loaded before this change never locks itself.
sodRouter.get("/sod/today", async (req, res, next) => {
  try {
    await closeStaleSessions();
    const eid = await callerEditorId(req);
    if (req.role !== "editor" || !eid) return res.json({ required: false, plan: null, startedAt: null, candidates: [] });
    const { rows: first } = await pool.query(
      "select min(started_at) as started_at from eod_session where editor_id = $1 and date = current_date",
      [eid],
    );
    res.json({
      required: false,
      plan: await planFor(req.orgId, eid, null),
      startedAt: first[0]?.started_at ?? null,
      candidates: await planCandidates(req.orgId, eid, req.user.sub),
    });
  } catch (err) { next(err); }
});

const SaveSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  taskIds: z.array(z.string().uuid()).max(500),
});

// Save today's SOD — on every Copy SOD; the latest copy replaces the earlier
// one. `taskIds` are the ticked tasks. The task details are recomputed here
// rather than trusted from the browser; unticked tasks that were added today or
// are already on their plate stay in the record as "skipped" (shown to the
// admin, not counted), unticked ones due later are simply left out.
sodRouter.post("/sod", async (req, res, next) => {
  const parsed = SaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That Start of Day couldn't be read." });
  try {
    if (req.role !== "editor") return res.status(403).json({ error: "Only team members who Start Work have a Start of Day." });
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your login isn't linked to a team member." });
    const { rowCount: started } = await pool.query(
      "select 1 from eod_session where editor_id = $1 and date = current_date", [eid],
    );
    if (!started) return res.status(400).json({ error: "Press Start Work first." });

    const picked = new Set(parsed.data.taskIds);
    const tasks = (await planCandidates(req.orgId, eid, req.user.sub))
      .filter((t) => picked.has(t.id) || t.group !== "later")
      .map(({ suggested: _suggested, ...t }) => (picked.has(t.id) ? t : { ...t, group: "skipped" }));
    const inPlan = tasks.filter((t) => t.group !== "skipped").length;
    const note = parsed.data.note || null;
    const { rows } = await pool.query(
      `insert into sod_plan (org_id, editor_id, date, note, tasks)
       values ($1, $2, current_date, $3, $4::jsonb)
       on conflict (editor_id, date) do update
         set tasks = excluded.tasks, note = excluded.note, submitted_at = now()
       returning (xmax = 0) as first`,
      [req.orgId, eid, note, JSON.stringify(tasks)],
    );
    // The feed hears about the day's first SOD only, not every re-copy.
    if (rows[0]?.first) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "sod_submitted",
        entityType: "user", entityId: req.user.sub,
        summary: `Shared their Start of Day (${inPlan} task${inPlan === 1 ? "" : "s"})`,
        meta: { editorId: eid },
      });
    }
    res.json({ plan: await planFor(req.orgId, eid, null) });
  } catch (err) { next(err); }
});

// A plan for a date — your own, or (admins) anyone's via ?editorId=.
sodRouter.get("/sod", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "A valid date is required." });
    let editorId = req.query.editorId ? String(req.query.editorId) : null;
    if (editorId && req.role !== "admin") return res.status(403).json({ error: "Admins only." });
    if (!editorId) editorId = await callerEditorId(req);
    if (!editorId) return res.status(400).json({ error: "No team member to show." });
    res.json({ plan: await planFor(req.orgId, editorId, date) });
  } catch (err) { next(err); }
});
