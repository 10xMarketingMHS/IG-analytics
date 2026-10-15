import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { logActivity } from "../activity.js";
import { closeStaleSessions } from "./eod.js";

// Start of Day (SOD): once each morning, after the first Start Work, an employee
// sends their plan for the day — every task they'll work on. Tasks already on
// their plate (due today or late, in progress, sent back, waiting for Accept) are
// in it automatically; anything else they first add as a task on the board, and
// they may also pick up open tasks due later. The plan is saved as sent (a
// snapshot), the admin sees it, and the End of Day summary compares it with what
// got done. Until it's sent, task work is refused (requireTodaysPlan).
export const sodRouter = Router();

async function callerEditorId(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}

// The employee's open tasks, sorted into the plan screen's groups:
//   added — created by them today (always in the plan)
//   today — due today or late, in progress, sent back, or waiting for Accept
//           (always in the plan)
//   later — everything else still open (they may tick some in)
// Tasks waiting in Review are left out: that's the reviewer's move, not theirs.
async function planCandidates(orgId, editorId, userId) {
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.accepted, t.pending_note, t.on_hold, t.due_date,
            cf.name as format,
            (t.created_by = $3 and t.created_at::date = current_date) as "addedToday",
            (current_date - t.due_date) as "daysLate"
       from task t
       left join task_content_format cf on cf.id = t.content_format_id
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
    return { id: t.id, title: t.title, format: t.format, dueDate: t.due_date, status: t.status, group, reason: reasons.join(", ") };
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

// The caller's SOD state: whether a plan is due now (an employee who has started
// work today and not sent one), the plan if sent, and the plan screen's tasks.
sodRouter.get("/sod/today", async (req, res, next) => {
  try {
    await closeStaleSessions();
    const eid = await callerEditorId(req);
    if (req.role !== "editor" || !eid) return res.json({ required: false, plan: null, startedAt: null, candidates: [] });
    const { rows: open } = await pool.query(
      "select started_at from eod_session where editor_id = $1 and ended_at is null limit 1",
      [eid],
    );
    const plan = await planFor(req.orgId, eid, null);
    const required = open.length > 0 && !plan;
    res.json({
      required,
      plan,
      startedAt: open[0]?.started_at ?? null,
      candidates: required ? await planCandidates(req.orgId, eid, req.user.sub) : [],
    });
  } catch (err) { next(err); }
});

const SendSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  extraTaskIds: z.array(z.string().uuid()).max(200).optional(),
  skipTaskIds: z.array(z.string().uuid()).max(200).optional(),
});

// Send today's plan — once per day. The always-in groups are recomputed here
// rather than trusted from the browser; `extraTaskIds` are open tasks due later
// that the employee ticked, `skipTaskIds` tasks already on their plate that
// they unticked (not working on them today). Those stay in the plan's record as
// "skipped", so the admin sees what was left out — but they don't count.
sodRouter.post("/sod", async (req, res, next) => {
  const parsed = SendSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That plan couldn't be read." });
  try {
    if (req.role !== "editor") return res.status(403).json({ error: "Only team members who Start Work send a day plan." });
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your login isn't linked to a team member." });
    const { rowCount: working } = await pool.query(
      "select 1 from eod_session where editor_id = $1 and ended_at is null", [eid],
    );
    if (!working) return res.status(400).json({ error: "Press Start Work first." });
    if (await planFor(req.orgId, eid, null)) return res.status(409).json({ error: "Today's plan was already sent." });

    const extra = new Set(parsed.data.extraTaskIds ?? []);
    const skip = new Set(parsed.data.skipTaskIds ?? []);
    const tasks = (await planCandidates(req.orgId, eid, req.user.sub))
      .filter((t) => t.group !== "later" || extra.has(t.id))
      .map((t) => (t.group === "today" && skip.has(t.id) ? { ...t, group: "skipped" } : t));
    const inPlan = tasks.filter((t) => t.group !== "skipped").length;
    const note = parsed.data.note || null;
    const { rows } = await pool.query(
      `insert into sod_plan (org_id, editor_id, date, note, tasks)
       values ($1, $2, current_date, $3, $4::jsonb)
       on conflict (editor_id, date) do nothing
       returning id`,
      [req.orgId, eid, note, JSON.stringify(tasks)],
    );
    if (!rows.length) return res.status(409).json({ error: "Today's plan was already sent." });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "sod_submitted",
      entityType: "user", entityId: req.user.sub,
      summary: `Sent today's plan (${inPlan} task${inPlan === 1 ? "" : "s"})`,
      meta: { editorId: eid },
    });
    res.status(201).json({ plan: await planFor(req.orgId, eid, null) });
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

// Task work waits for the morning plan: an employee who has started work today
// must send it before accepting, moving or changing tasks. Creating a task (the
// plan screen adds them) and deleting one's own new task stay open.
export async function requireTodaysPlan(req, res, next) {
  try {
    if (req.role !== "editor") return next();
    const eid = await callerEditorId(req);
    if (!eid) return next();
    const { rowCount } = await pool.query(
      "select 1 from sod_plan where editor_id = $1 and date = current_date", [eid],
    );
    if (!rowCount) return res.status(403).json({ error: "Send today's plan first — press Plan your day on My Day." });
    next();
  } catch (err) { next(err); }
}
