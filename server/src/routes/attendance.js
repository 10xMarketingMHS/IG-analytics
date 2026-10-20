import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { editorRanks, taskViewer } from "../hierarchy.js";
import { logActivity } from "../activity.js";
import { capacityFor, LUNCH_MIN, TEA_MIN, normalizeCalendar } from "../work-calendar.js";
import { startSession, endSession, pauseDayTimers } from "./eod.js";
import {
  applyEveningPermission, applyMorningPermission, attendancePeople, giveBackPermission, attendanceReady, callerScope, canSee, classify, closingFor,
  istAt, istNow, minutesOf, openingFor, penaltyOf, permissionsReady, permissionsThisMonth, readSettings, syncAttendance, weekdayOf,
} from "../attendance.js";

// Attendance — Start day / End day for team members, and Team today /
// Team › Attendance for their leads and managers. Rules: attendance.js.
export const attendanceRouter = Router();

const NEEDS_DB = "Attendance needs a database update first — ask whoever runs the database to apply 20261025120000_attendance.";
const ROW_COLS = `id, editor_id as "editorId", date::text as date, check_in_at as "checkInAt", check_out_at as "checkOutAt",
  plan_note as "planNote", eod_note as "eodNote", status, late_minutes as "lateMinutes", excused,
  marked_by as "markedBy", auto_marked as "autoMarked", reason, alert_sent_at as "alertSentAt", nudged_at as "nudgedAt",
  correction_at as "correctionAt", correction_note as "correctionNote", correction_status as "correctionStatus"`;

async function ready(res) {
  if (await attendanceReady()) return true;
  res.status(409).json({ error: NEEDS_DB });
  return false;
}
async function rowFor(editorId, ymd) {
  const { rows } = await pool.query(`select ${ROW_COLS} from attendance where editor_id = $1 and date = $2`, [editorId, ymd]);
  return rows[0] ?? null;
}
// What a row (or its absence) shows as right now: the stored status, or
// "waiting" (not in yet) before the no-SOD alert has gone out — a row kept
// only to remember a nudge isn't a no-SOD day yet.
function shownStatus(row) {
  if (!row) return "waiting";
  if (row.status === "late" && row.excused) return row.reason === "permission" ? "permission" : "on_time";
  if (row.status === "no_sod" && !row.alertSentAt && !row.checkInAt && !row.markedBy) return "waiting";
  return row.status;
}

// GET /attendance/today — the caller's own day (for the Start day card) and,
// for team leads and managers, their people (the Team today widget).
attendanceRouter.get("/attendance/today", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    // Pulse's own marks (the no-SOD alert, auto-absent) are applied at most
    // once a minute, in the background: the answer doesn't wait for them, and
    // they show on the next look.
    syncAttendance(req.orgId).catch(() => {});
    // who's asking, the rules and who checks in don't depend on each other:
    // read them together (each is a trip to the database)
    const [caller, { cal, att }, people] = await Promise.all([
      callerScope(req), readSettings(req.orgId), attendancePeople(req.orgId),
    ]);
    const today = istNow();
    const open = openingFor(cal, today.ymd);
    const checksIn = !!caller.editorId && people.some((p) => p.id === caller.editorId);
    // Everyone who checks in, apart from yourself (your own day is the bar above).
    const mine = caller.scope !== "self" ? people.filter((p) => p.id !== caller.editorId) : [];
    const ids = mine.map((p) => p.id);
    const [me, teamRows] = await Promise.all([
      checksIn ? rowFor(caller.editorId, today.ymd) : Promise.resolve(null),
      ids.length
        ? pool.query(`select ${ROW_COLS} from attendance where editor_id = any($1::uuid[]) and date = $2`, [ids, today.ymd])
        : Promise.resolve({ rows: [] }),
    ]);

    // Permissions: yours this month, and the requests waiting for a lead.
    const permReady = await permissionsReady();
    const [myPerms, waitingPerms] = await Promise.all([
      checksIn && permReady ? permissionsThisMonth(caller.editorId, today.ymd) : Promise.resolve([]),
      permReady && ids.length
        ? pool.query(
          `select id, editor_id as "editorId", date::text as date, part, note from attendance_permission
            where editor_id = any($1::uuid[]) and status = 'requested' and date >= $2::date order by date`,
          [ids, today.ymd],
        )
        : Promise.resolve({ rows: [] }),
    ]);
    let team = null;
    if (caller.scope !== "self") {
      const byId = new Map(teamRows.rows.map((r) => [r.editorId, r]));
      const askedBy = new Map();
      for (const w of waitingPerms.rows) { if (!askedBy.has(w.editorId)) askedBy.set(w.editorId, []); askedBy.get(w.editorId).push(w); }
      team = mine.map((p) => {
        const r = byId.get(p.id) ?? null;
        return {
          editorId: p.id, name: p.name, imageUrl: p.imageUrl, designation: p.designation,
          status: shownStatus(r), row: r, penalty: penaltyOf(r, att),
          permissionRequests: askedBy.get(p.id) ?? [],
        };
      });
    }
    res.json({
      date: today.ymd, now: new Date().toISOString(),
      opening: open, closing: closingFor(cal, today.ymd),
      settings: att, role: caller.role, scope: caller.scope,
      checksIn, me, team,
      permissions: permReady ? { perMonth: att.permissionsPerMonth, mine: myPerms, left: Math.max(0, att.permissionsPerMonth - myPerms.length) } : null,
    });
  } catch (err) { next(err); }
});

// POST /attendance/check-in { plan } — Start day: check in, classify on time /
// late, and open the work session (unlocks the app, like Start Work did).
attendanceRouter.post("/attendance/check-in", async (req, res, next) => {
  const parsed = z.object({ plan: z.string().trim().max(1000).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That plan couldn't be read." });
  try {
    if (!(await ready(res))) return;
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { cal, att } = await readSettings(req.orgId);
    const today = istNow();
    const { session } = await startSession(req.orgId, caller.editorId);
    const existing = await rowFor(caller.editorId, today.ymd);
    const plan = parsed.data.plan || null;
    if (existing?.checkInAt) {
      // Already in today — Start day again after closing it reopens the day.
      await pool.query(
        "update attendance set plan_note = coalesce($2, plan_note), check_out_at = null, updated_at = now() where id = $1",
        [existing.id, plan],
      );
      return res.json({ attendance: await rowFor(caller.editorId, today.ymd), session });
    }
    const at = session?.startedAt ?? new Date();
    const c = classify(at, today.ymd, cal, att);
    await pool.query(
      `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes, plan_note)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (editor_id, date) do update set
         check_in_at = excluded.check_in_at,
         status = case when (attendance.marked_by is not null and attendance.status in ('on_time', 'half_day', 'absent'))
                         or (attendance.auto_marked and attendance.status in ('absent', 'half_absent'))
                       then attendance.status else excluded.status end,
         late_minutes = excluded.late_minutes,
         auto_marked = attendance.auto_marked and attendance.status in ('absent', 'half_absent'),
         marked_by = case when attendance.status = 'leave' then null else attendance.marked_by end,
         plan_note = coalesce(excluded.plan_note, attendance.plan_note), updated_at = now()`,
      [req.orgId, caller.editorId, today.ymd, at, c.status, c.lateMinutes, plan],
    );
    if (existing?.status === "leave" && existing?.markedBy) await leaveWorked(req, caller.editorId, today.ymd);
    await applyMorningPermission(req.orgId, caller.editorId, today.ymd, att, req.user.sub);
    const row = await rowFor(caller.editorId, today.ymd);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "attendance_check_in", entityType: "editor", entityId: caller.editorId,
      summary: row.status === "late" ? `Started their day ${row.lateMinutes}m late` : "Started their day",
      meta: { date: today.ymd, status: row.status },
    });
    res.status(201).json({ attendance: row, session, penalty: penaltyOf(row, att) });
  } catch (err) { next(err); }
});

// POST /attendance/undo-check-in — within 5 minutes of Start day.
attendanceRouter.post("/attendance/undo-check-in", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const today = istNow();
    const row = await rowFor(caller.editorId, today.ymd);
    if (!row?.checkInAt) return res.status(400).json({ error: "You haven't started your day." });
    if (Date.now() - new Date(row.checkInAt).getTime() > 5 * 60_000) {
      return res.status(409).json({ error: "Start day can only be undone in the first 5 minutes." });
    }
    await pool.query(
      "delete from eod_session where editor_id = $1 and ended_at is null and started_at > now() - interval '6 minutes'",
      [caller.editorId],
    );
    // Not started after all: the task clocks Start day set going stop again.
    await pauseDayTimers(caller.editorId);
    // A lead's mark (working now, leave, half day, absent) stays; otherwise the
    // day goes back to what the clock says — and an excuse goes with the late
    // start (a morning permission it used is given back).
    const { cal, att } = await readSettings(req.orgId);
    const leadMark = !!row.markedBy && !row.excused && ["on_time", "leave", "half_day", "absent", "half_absent"].includes(row.status);
    if (row.excused && row.reason === "permission") await giveBackPermission(caller.editorId, today.ymd, "morning");
    const opens = !!openingFor(cal, today.ymd);
    const absent = att.autoAbsentEnabled && opens && today.minutes >= minutesOf(att.autoAbsentAt);
    const halfAbsent = !absent && att.autoAbsentEnabled && att.halfDayReady !== false && opens && today.minutes >= minutesOf(att.halfDayAt);
    const alerted = today.minutes >= minutesOf(att.noSodAlertAt);
    if (leadMark) {
      await pool.query("update attendance set check_in_at = null, late_minutes = 0, updated_at = now() where id = $1", [row.id]);
    } else if (absent || halfAbsent || alerted || row.planNote || row.correctionStatus) {
      await pool.query(
        `update attendance set check_in_at = null, late_minutes = 0, excused = false, reason = null, marked_by = null,
           status = $2, auto_marked = $3, updated_at = now() where id = $1`,
        [row.id, absent ? "absent" : halfAbsent ? "half_absent" : "no_sod", absent || halfAbsent],
      );
    } else {
      await pool.query("delete from attendance where id = $1", [row.id]);
    }
    res.json({ attendance: await rowFor(caller.editorId, today.ymd) });
  } catch (err) { next(err); }
});

// POST /attendance/check-out { note } — End day: the wrap-up note (required
// when Settings › Attendance asks for it), close the work session, and return
// the day's summary (the report to copy).
attendanceRouter.post("/attendance/check-out", async (req, res, next) => {
  const parsed = z.object({ note: z.string().trim().max(2000).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That note couldn't be read." });
  try {
    if (!(await ready(res))) return;
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { att } = await readSettings(req.orgId);
    const note = parsed.data.note || "";
    if (att.requireEodNote && !note) return res.status(400).json({ error: "Add a short wrap-up note first." });
    const today = istNow();
    // Nothing is saved for a day that wasn't started.
    const { rowCount: open } = await pool.query("select 1 from eod_session where editor_id = $1 and ended_at is null limit 1", [caller.editorId]);
    if (!open) return res.status(400).json({ error: "You haven't started your day, so there's nothing to close." });
    if (note) {
      // A day with no record yet (started with Start Work) is recorded from its
      // first start, late or on time as it was; End day only adds the note.
      const { rows: first } = await pool.query(
        `select min(started_at) as at from eod_session
          where editor_id = $1 and (started_at at time zone 'Asia/Kolkata')::date = $2::date`,
        [caller.editorId, today.ymd],
      );
      const { cal } = await readSettings(req.orgId);
      const startedAt = first[0]?.at ?? new Date();
      const c = classify(startedAt, today.ymd, cal, att);
      await pool.query(
        `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes, eod_note) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (editor_id, date) do update set eod_note = excluded.eod_note, updated_at = now()`,
        [req.orgId, caller.editorId, today.ymd, startedAt, c.status, c.lateMinutes, note],
      );
    }
    const ended = await endSession(req.orgId, caller.editorId);
    if (!ended) return res.status(400).json({ error: "You haven't started your day, so there's nothing to close." });
    const { cal: dayCal } = await readSettings(req.orgId);
    const evening = await applyEveningPermission(req.orgId, caller.editorId, today.ymd, dayCal, att, req.user.sub);
    res.json({ ...ended, attendance: await rowFor(caller.editorId, today.ymd), eveningPermission: evening });
  } catch (err) { next(err); }
});

// POST /attendance/correction-request { time: "HH:MM", note } — "Started
// earlier? Request a correction": checks in now (so work can start) and asks
// the person's lead to set the start to the time given.
attendanceRouter.post("/attendance/correction-request", async (req, res, next) => {
  const parsed = z.object({ time: z.string().regex(/^\d{2}:\d{2}$/), note: z.string().trim().max(500).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Give the time you started, like 09:00." });
  try {
    if (!(await ready(res))) return;
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { cal, att } = await readSettings(req.orgId);
    if (!att.allowCorrections) return res.status(403).json({ error: "Corrections are turned off in Settings › Attendance." });
    const today = istNow();
    const asked = istAt(today.ymd, parsed.data.time);
    if (asked.getTime() > Date.now()) return res.status(400).json({ error: "That time hasn't happened yet." });
    // Not before an hour ahead of opening, on a working day, and once a day.
    const opens = openingFor(cal, today.ymd);
    if (!opens) return res.status(400).json({ error: "Today isn't a working day." });
    const earliest = istAt(today.ymd, opens).getTime() - 60 * 60_000;
    if (asked.getTime() < earliest) {
      return res.status(400).json({ error: `Pick a time from ${clockOf(new Date(earliest))} onwards.` });
    }
    const already = await rowFor(caller.editorId, today.ymd);
    if (already?.correctionStatus) return res.status(409).json({ error: "You've already asked for a correction today." });
    const { session } = await startSession(req.orgId, caller.editorId);
    const now = session?.startedAt ?? new Date();
    const c = classify(now, today.ymd, cal, att);
    await pool.query(
      `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes, correction_at, correction_note, correction_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       on conflict (editor_id, date) do update set
         check_in_at = coalesce(attendance.check_in_at, excluded.check_in_at),
         status = case when attendance.check_in_at is not null then attendance.status else case when (attendance.marked_by is not null and attendance.status in ('on_time', 'half_day', 'absent'))
                         or (attendance.auto_marked and attendance.status in ('absent', 'half_absent'))
                       then attendance.status else excluded.status end end,
         late_minutes = case when attendance.check_in_at is not null then attendance.late_minutes else excluded.late_minutes end,
         auto_marked = false, correction_at = excluded.correction_at, correction_note = excluded.correction_note,
         correction_status = 'pending', updated_at = now()`,
      [req.orgId, caller.editorId, today.ymd, now, c.status, c.lateMinutes, asked, parsed.data.note || null],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "attendance_correction", entityType: "editor", entityId: caller.editorId,
      summary: `Asked to correct their start time to ${parsed.data.time}`,
      meta: { date: today.ymd, time: parsed.data.time },
    });
    res.status(201).json({ attendance: await rowFor(caller.editorId, today.ymd), session });
  } catch (err) { next(err); }
});

// ---- Lead and manager actions on one person's day (today) ----

// Someone a lead marked on leave checked in anyway: it's a working day now (the
// check-in already counts it as one), and the lead is told, to mark leave
// again if that's really right.
async function leaveWorked(req, editorId, ymd) {
  const { rows: who } = await pool.query("select name from editor where id = $1", [editorId]);
  await logActivity({
    orgId: req.orgId, actorId: req.user.sub, verb: "attendance_leave_worked", entityType: "editor", entityId: editorId,
    summary: `${who[0]?.name ?? "Someone"} checked in on a day marked as leave, so it counts as a working day. Mark leave again if that's right.`,
    meta: { date: ymd },
  });
}
// A clock time on India time, 12-hour (for messages).
function clockOf(d) {
  const t = new Date(d.getTime() + 330 * 60_000);
  const h = t.getUTCHours();
  return `${h % 12 || 12}:${String(t.getUTCMinutes()).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

async function leadTarget(req, res) {
  if (!(await ready(res))) return null;
  const caller = await callerScope(req);
  const editorId = req.params.editorId;
  if (caller.scope === "self" || editorId === caller.editorId || !(await canSee(caller, editorId))) {
    res.status(403).json({ error: "Only a team lead or a manager can do that." });
    return null;
  }
  const { rows } = await pool.query("select name from editor where id = $1 and org_id = $2", [editorId, req.orgId]);
  if (!rows.length) { res.status(404).json({ error: "Team member not found." }); return null; }
  // Only for people below you in position (the Super Admin: anyone).
  const [viewer, ranks] = await Promise.all([taskViewer(req), editorRanks(req.orgId)]);
  if (!viewer.seesAll && !((ranks.get(editorId) ?? 3) > viewer.rank)) {
    res.status(403).json({ error: "You can do that only for people below you." });
    return null;
  }
  return { caller, editorId, name: rows[0].name, today: istNow() };
}
async function audit(req, t, verb, summary, meta = {}) {
  await logActivity({
    orgId: req.orgId, actorId: req.user.sub, verb, entityType: "editor", entityId: t.editorId,
    summary, meta: { date: t.today.ymd, ...meta },
  });
}

// POST /attendance/:editorId/excuse — clears the late mark and its penalty.
attendanceRouter.post("/attendance/:editorId/excuse", async (req, res, next) => {
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    const { rowCount } = await pool.query(
      "update attendance set excused = true, marked_by = $3, updated_at = now() where editor_id = $1 and date = $2 and status = 'late'",
      [t.editorId, t.today.ymd, req.user.sub],
    );
    if (!rowCount) return res.status(400).json({ error: `${t.name} isn't marked late today.` });
    await audit(req, t, "attendance_excused", `Excused ${t.name}'s late start`);
    res.json({ attendance: await rowFor(t.editorId, t.today.ymd) });
  } catch (err) { next(err); }
});

// POST /attendance/:editorId/mark { as, reason } — Working now / Half-day
// leave / On leave / Absent.
const MARKS = { working: "on_time", half_day: "half_day", leave: "leave", absent: "absent" };
const MARK_WORDS = { working: "working now", half_day: "on half-day leave", leave: "on leave", absent: "absent" };
attendanceRouter.post("/attendance/:editorId/mark", async (req, res, next) => {
  const parsed = z.object({
    as: z.enum(["working", "half_day", "leave", "absent"]),
    reason: z.string().trim().max(300).optional(),
    // another day: leave or half day, planned ahead or fixed afterwards
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick what to mark them as." });
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    const day = parsed.data.date ?? t.today.ymd;
    if (day !== t.today.ymd) {
      if (parsed.data.as !== "leave" && parsed.data.as !== "half_day") {
        return res.status(400).json({ error: "For another day, mark leave or half-day leave." });
      }
      const d0 = new Date(`${t.today.ymd}T00:00:00Z`);
      const from = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
      const to = new Date(d0.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
      if (day < from || day > to) return res.status(400).json({ error: "Pick a day from last month to three months ahead." });
      const { rows: worked } = await pool.query("select 1 from attendance where editor_id = $1 and date = $2 and check_in_at is not null", [t.editorId, day]);
      if (worked.length && parsed.data.as === "leave") return res.status(409).json({ error: "They checked in that day, so it can't be leave." });
    }
    // only working days (not Sundays, a Saturday off, or a holiday)
    const { cal } = await readSettings(req.orgId);
    if (!openingFor(cal, day)) return res.status(400).json({ error: "That isn't a working day." });
    const status = MARKS[parsed.data.as];
    await pool.query(
      `insert into attendance (org_id, editor_id, date, status, marked_by, reason, auto_marked)
       values ($1, $2, $3, $4, $5, $6, false)
       on conflict (editor_id, date) do update set status = excluded.status, marked_by = excluded.marked_by,
         reason = excluded.reason, auto_marked = false, excused = false, updated_at = now()`,
      [req.orgId, t.editorId, day, status, req.user.sub, parsed.data.reason || null],
    );
    await audit(req, t, "attendance_marked", `Marked ${t.name} as ${MARK_WORDS[parsed.data.as]}${day !== t.today.ymd ? ` on ${day}` : ""}`, { as: parsed.data.as, date: day });
    res.json({ attendance: await rowFor(t.editorId, day) });
  } catch (err) { next(err); }
});

// POST /attendance/:editorId/undo — takes back a lead's mark or excuse; the day
// goes back to what the rules say.
attendanceRouter.post("/attendance/:editorId/undo", async (req, res, next) => {
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date ?? "")) ? req.body.date : t.today.ymd;
    if (day !== t.today.ymd) {
      // another day: only a leave or half day a lead marked, in the same window as marking
      const d0 = new Date(`${t.today.ymd}T00:00:00Z`);
      const from = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
      const to = new Date(d0.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
      if (day < from || day > to) return res.status(400).json({ error: "Pick a day from last month to three months ahead." });
      const other = await rowFor(t.editorId, day);
      if (!other?.markedBy || !["leave", "half_day"].includes(other.status)) {
        return res.status(400).json({ error: "There's no leave a lead marked on that day." });
      }
      const { cal: dayCal, att: dayAtt } = await readSettings(req.orgId);
      if (other.checkInAt) {
        const c = classify(other.checkInAt, day, dayCal, dayAtt);
        await pool.query(
          "update attendance set status = $2, late_minutes = $3, excused = false, marked_by = null, reason = null, updated_at = now() where id = $1",
          [other.id, c.status, c.lateMinutes],
        );
      } else {
        // a day ahead goes back to nothing; a past one is filled in by the usual rules
        await pool.query("delete from attendance where id = $1", [other.id]);
      }
      await audit(req, t, "attendance_undone", `Undid the leave mark for ${t.name} on ${day}`, { date: day });
      return res.json({ attendance: await rowFor(t.editorId, day) });
    }
    const row = await rowFor(t.editorId, t.today.ymd);
    if (!row?.markedBy) return res.status(400).json({ error: "There's nothing a lead marked to undo." });
    const { cal, att } = await readSettings(req.orgId);
    if (row.checkInAt) {
      const c = classify(row.checkInAt, t.today.ymd, cal, att);
      await pool.query(
        "update attendance set status = $2, late_minutes = $3, excused = false, marked_by = null, reason = null, updated_at = now() where id = $1",
        [row.id, c.status, c.lateMinutes],
      );
    } else {
      const opens = !!openingFor(cal, t.today.ymd);
      const absent = att.autoAbsentEnabled && t.today.minutes >= minutesOf(att.autoAbsentAt) && opens;
      const halfAbsent = !absent && att.autoAbsentEnabled && att.halfDayReady !== false && t.today.minutes >= minutesOf(att.halfDayAt) && opens;
      const alerted = t.today.minutes >= minutesOf(att.noSodAlertAt);
      if (!absent && !halfAbsent && !alerted) await pool.query("delete from attendance where id = $1", [row.id]);
      else {
        await pool.query(
          "update attendance set status = $2, auto_marked = $3, excused = false, marked_by = null, reason = null, updated_at = now() where id = $1",
          [row.id, absent ? "absent" : halfAbsent ? "half_absent" : "no_sod", absent || halfAbsent],
        );
      }
    }
    await audit(req, t, "attendance_undone", `Undid the attendance mark for ${t.name}`);
    res.json({ attendance: await rowFor(t.editorId, t.today.ymd) });
  } catch (err) { next(err); }
});

// POST /attendance/:editorId/nudge — an in-app ping to start their day.
attendanceRouter.post("/attendance/:editorId/nudge", async (req, res, next) => {
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    await pool.query(
      `insert into attendance (org_id, editor_id, date, status, nudged_at) values ($1, $2, $3, 'no_sod', now())
       on conflict (editor_id, date) do update set nudged_at = now(), updated_at = now()`,
      [req.orgId, t.editorId, t.today.ymd],
    );
    await audit(req, t, "attendance_nudge", `Nudged ${t.name} to start their day`);
    res.json({ attendance: await rowFor(t.editorId, t.today.ymd) });
  } catch (err) { next(err); }
});

// POST /attendance/permission { date, part, note } — ask ahead for a morning
// (come in late) or evening (leave early) permission; a lead approves it.
attendanceRouter.post("/attendance/permission", async (req, res, next) => {
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    part: z.enum(["morning", "evening"]),
    note: z.string().trim().max(300).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick the day and morning or evening." });
  try {
    if (!(await ready(res))) return;
    if (!(await permissionsReady())) return res.status(409).json({ error: "Permissions need a database update first — ask whoever runs the database to apply 20261029120000_attendance_permission." });
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { cal, att } = await readSettings(req.orgId);
    const today = istNow();
    const { date, part } = parsed.data;
    const until = new Date(new Date(`${today.ymd}T00:00:00Z`).getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
    if (date < today.ymd || date > until) return res.status(400).json({ error: "Pick a day from today to two months ahead." });
    if (!openingFor(cal, date)) return res.status(400).json({ error: "That isn't a working day." });
    const month = await permissionsThisMonth(caller.editorId, date);
    if (month.some((p) => p.date === date && p.part === part)) return res.status(409).json({ error: "You've already asked for that one." });
    if (month.length >= att.permissionsPerMonth) {
      return res.status(409).json({ error: `You've used all ${att.permissionsPerMonth} permissions for that month.` });
    }
    await pool.query(
      `insert into attendance_permission (org_id, editor_id, date, part, status, note, asked_by)
       values ($1, $2, $3, $4, 'requested', $5, $6)
       on conflict (editor_id, date, part) do update set status = 'requested', note = excluded.note, decided_by = null, decided_at = null`,
      [req.orgId, caller.editorId, date, part, parsed.data.note || null, req.user.sub],
    );
    const { rows: who } = await pool.query("select name from editor where id = $1", [caller.editorId]);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "attendance_permission_asked", entityType: "editor", entityId: caller.editorId,
      summary: `${who[0]?.name ?? "Someone"} asked for a ${part} permission on ${date}`,
      meta: { date, part },
    });
    res.status(201).json({ permissions: await permissionsThisMonth(caller.editorId, date) });
  } catch (err) { next(err); }
});

// POST /attendance/:editorId/permission { id, approve } — a lead's answer.
attendanceRouter.post("/attendance/:editorId/permission", async (req, res, next) => {
  const parsed = z.object({ id: z.string().uuid(), approve: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Approve or decline." });
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    if (!(await permissionsReady())) return res.status(409).json({ error: "Permissions need a database update first." });
    const { rows } = await pool.query(
      `update attendance_permission set status = $3, decided_by = $4, decided_at = now()
        where id = $1 and editor_id = $2 and status = 'requested' returning date::text as date, part`,
      [parsed.data.id, t.editorId, parsed.data.approve ? "approved" : "declined", req.user.sub],
    );
    if (!rows.length) return res.status(400).json({ error: "There's no request waiting." });
    await audit(req, t, parsed.data.approve ? "attendance_permission_approved" : "attendance_permission_declined",
      `${parsed.data.approve ? "Approved" : "Declined"} ${t.name}'s ${rows[0].part} permission on ${rows[0].date}`, rows[0]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /attendance/:editorId/correction { approve } — the lead's answer to a
// correction request.
attendanceRouter.post("/attendance/:editorId/correction", async (req, res, next) => {
  const parsed = z.object({ approve: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Approve or decline." });
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    // the latest one waiting, from today or the few days before (asked late in the day, answered the next)
    const { rows: waiting } = await pool.query(
      `select date::text as day from attendance
        where editor_id = $1 and correction_status = 'pending' and date >= $2::date - 3 and date <= $2::date
        order by date desc limit 1`,
      [t.editorId, t.today.ymd],
    );
    const day = waiting[0]?.day ?? t.today.ymd;
    const row = await rowFor(t.editorId, day);
    if (!row || row.correctionStatus !== "pending") return res.status(400).json({ error: "There's no correction waiting." });
    if (parsed.data.approve) {
      const { cal, att } = await readSettings(req.orgId);
      const c = classify(row.correctionAt, day, cal, att);
      const keep = row.markedBy && ["on_time", "leave", "half_day", "absent", "half_absent"].includes(row.status);
      await pool.query(
        `update attendance set check_in_at = correction_at, status = $2, late_minutes = $3,
           correction_status = 'approved', updated_at = now() where id = $1`,
        [row.id, keep ? row.status : c.status, c.lateMinutes],
      );
      // Only the day's first session starts earlier; later ones (a reopened
      // day) stay as they were, so no hours are counted twice.
      await pool.query(
        `update eod_session set started_at = $2
          where id = (select id from eod_session where editor_id = $1 and (started_at at time zone 'Asia/Kolkata')::date = $3::date
                       order by started_at limit 1)
            and started_at > $2`,
        [t.editorId, row.correctionAt, day],
      );
    } else {
      await pool.query("update attendance set correction_status = 'declined', updated_at = now() where id = $1", [row.id]);
    }
    await audit(req, t, "attendance_correction_answered", `${parsed.data.approve ? "Approved" : "Declined"} ${t.name}'s start-time correction`, { approve: parsed.data.approve });
    res.json({ attendance: await rowFor(t.editorId, t.today.ymd) });
  } catch (err) { next(err); }
});

// GET /attendance/month?month=YYYY-MM — the Team › Attendance grid. Managers
// see everyone, team leads their team, everyone else only their own row.
attendanceRouter.get("/attendance/month", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    // Pulse's own marks (the no-SOD alert, auto-absent) are applied at most
    // once a minute, in the background: the answer doesn't wait for them, and
    // they show on the next look.
    syncAttendance(req.orgId).catch(() => {});
    const today = istNow();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : today.ymd.slice(0, 7);
    const caller = await callerScope(req);
    const { cal, att } = await readSettings(req.orgId);
    const people = await attendancePeople(req.orgId);
    // ?self=1 (My profile): just your own row, whatever you can see.
    const shown = req.query.self === "1" || caller.scope === "self" ? people.filter((p) => p.id === caller.editorId) : people;
    const [y, m] = month.split("-").map(Number);
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days = Array.from({ length: count }, (_, i) => {
      const ymd = `${month}-${String(i + 1).padStart(2, "0")}`;
      return { date: ymd, weekday: weekdayOf(ymd), working: !!openingFor(cal, ymd), future: ymd > today.ymd, today: ymd === today.ymd };
    });
    const ids = shown.map((p) => p.id);
    const { rows } = ids.length
      ? await pool.query(`select ${ROW_COLS} from attendance where editor_id = any($1::uuid[]) and to_char(date, 'YYYY-MM') = $2`, [ids, month])
      : { rows: [] };
    const byKey = new Map(rows.map((r) => [`${r.editorId}|${r.date}`, r]));
    const c = normalizeCalendar(cal);
    const dayMin = Math.max(0, minutesOf(c.wdTo) - minutesOf(c.wdFrom) - LUNCH_MIN - TEA_MIN);
    let absences = 0;
    const out = shown.map((p) => {
      let late = 0, absent = 0, leave = 0, onTime = 0, pts = 0;
      const cells = days.map((d) => {
        const r = byKey.get(`${p.id}|${d.date}`) ?? null;
        if (!d.working || d.future) return { status: null, row: null };
        const s = r ? shownStatus(r) : d.today ? "waiting" : null;
        if (r) {
          if (r.status === "late" && !r.excused) late++;
          else if (r.status === "on_time" || (r.status === "late" && r.excused)) onTime++;
          if (r.status === "absent") absent++;
          if (r.status === "half_absent") absent += 0.5;
          if (r.status === "leave") leave += 1;
          if (r.status === "half_day") leave += 0.5;
          pts += penaltyOf(r, att);
        }
        return { status: s, row: r ? { checkInAt: r.checkInAt, lateMinutes: r.lateMinutes, excused: r.excused, reason: r.reason } : null };
      });
      absences += absent;
      const present = onTime + late;
      return {
        editorId: p.id, name: p.name, imageUrl: p.imageUrl, designation: p.designation, cells,
        totals: { late, absent, leave, onTimePct: present ? Math.round((onTime / present) * 100) : null, ptsLost: pts },
      };
    });
    const cap = capacityFor(cal, y, m - 1);
    res.json({
      month, days, rows: out, settings: att, scope: caller.scope,
      footer: { absences, capacityLostMinutes: att.deductCapacity ? absences * dayMin : 0, latePts: att.latePenaltyPts, absentPts: att.absentPenaltyPts },
      capacity: cap,
    });
  } catch (err) { next(err); }
});

// GET /attendance/mine — the caller's own recent days (My profile).
attendanceRouter.get("/attendance/mine", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    const caller = await callerScope(req);
    if (!caller.editorId) return res.json({ rows: [] });
    const { rows } = await pool.query(
      `select ${ROW_COLS} from attendance where editor_id = $1 order by date desc limit 62`, [caller.editorId],
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

