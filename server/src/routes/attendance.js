import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { editorRanks, taskViewer } from "../hierarchy.js";
import { logActivity } from "../activity.js";
import { capacityFor, LUNCH_MIN, TEA_MIN, normalizeCalendar } from "../work-calendar.js";
import { startSession, endSession, pauseDayTimers } from "./eod.js";
import {
  afterHoursOf, applyEveningPermission, applyMorningPermission, attendancePeople, giveBackPermission, attendanceReady, callerScope, canSee, classify, closingFor, judgeHalfDay,
  istAt, istNow, lateNoteNeeded, lateNoteReady, leavePenalties, minutesOf, openingFor, outsideHoursNow, penaltyOf, permissionsReady, permissionsThisMonth, readSettings,
  syncAttendance, weekdayOf,
} from "../attendance.js";
import {
  LeaveError, WORKED, balances, createLeave, dropLeaveDay, isApprover, leaveReady, leaveRules, requestWords, restoreLeaveDay, workedLeaveDay,
} from "../leave.js";
import { validYmd } from "../leave-math.js";

// Attendance — Start day / End day for team members, and Team today /
// Team › Attendance for their leads and managers. Rules: attendance.js.
export const attendanceRouter = Router();

const NEEDS_DB = "Attendance needs a database update first — ask whoever runs the database to apply 20261025120000_attendance.";
const ROW_COLS = `id, editor_id as "editorId", date::text as date, check_in_at as "checkInAt", check_out_at as "checkOutAt",
  plan_note as "planNote", eod_note as "eodNote", status, late_minutes as "lateMinutes", excused,
  marked_by as "markedBy", auto_marked as "autoMarked", reason, alert_sent_at as "alertSentAt", nudged_at as "nudgedAt",
  correction_at as "correctionAt", correction_note as "correctionNote", correction_status as "correctionStatus"`;

// with the approved leave a day belongs to, once the database has leave
// (20261030120000_leave), and why a late start (20261102120000_attendance_late_note)
const rowCols = async () => ROW_COLS
  + ((await leaveReady()) ? `, leave_request_id as "leaveRequestId"` : "")
  + ((await lateNoteReady()) ? `, late_note as "lateNote"` : "");
// Does this day still wait for its late reason (and can the database keep one)?
const needsLateNote = async (row) => !!row && (await lateNoteReady()) && lateNoteNeeded(row);
const lateWords = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

async function ready(res) {
  if (await attendanceReady()) return true;
  res.status(409).json({ error: NEEDS_DB });
  return false;
}
async function rowFor(editorId, ymd) {
  const { rows } = await pool.query(`select ${await rowCols()} from attendance where editor_id = $1 and date = $2`, [editorId, ymd]);
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
    // Echo's own marks (the no-SOD alert, auto-absent) are applied at most
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
        ? pool.query(`select ${await rowCols()} from attendance where editor_id = any($1::uuid[]) and date = $2`, [ids, today.ymd])
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
    // Leave: your CL / SL left this year (the Start day card) and, for a
    // manager, how many requests wait (Team today).
    const leaveOn = await leaveReady();
    const year = Number(today.ymd.slice(0, 4));
    const approver = isApprover(caller);
    const none = { rows: [{ n: 0 }] };
    const [myBal, myWaiting, teamWaiting] = leaveOn
      ? await Promise.all([
        caller.editorId ? balances([caller.editorId], year) : new Map(),
        caller.editorId ? pool.query("select count(*)::int as n from leave_request where editor_id = $1 and status = 'pending'", [caller.editorId]) : none,
        approver
          ? pool.query("select count(*)::int as n from leave_request where org_id = $1 and status = 'pending' and editor_id is distinct from $2", [req.orgId, caller.editorId])
          : none,
      ])
      : [new Map(), none, none];
    let team = null;
    if (caller.scope !== "self") {
      const [viewer, ranks] = await Promise.all([taskViewer(req), editorRanks(req.orgId)]);
      const byId = new Map(teamRows.rows.map((r) => [r.editorId, r]));
      const askedBy = new Map();
      for (const w of waitingPerms.rows) { if (!askedBy.has(w.editorId)) askedBy.set(w.editorId, []); askedBy.get(w.editorId).push(w); }
      team = mine.map((p) => {
        const r = byId.get(p.id) ?? null;
        return {
          editorId: p.id, name: p.name, imageUrl: p.imageUrl, designation: p.designation,
          status: shownStatus(r), row: r, penalty: penaltyOf(r, att),
          permissionRequests: askedBy.get(p.id) ?? [],
          // marks, excuses and their requests (in the Inbox): only for people below you
          canAct: viewer.seesAll || (ranks.get(p.id) ?? 3) > viewer.rank,
        };
      });
    }
    res.json({
      date: today.ymd, now: new Date().toISOString(),
      opening: open, closing: closingFor(cal, today.ymd),
      settings: att, role: caller.role, scope: caller.scope,
      // lateNoteNeeded: started late and hasn't said why yet (the Start day dialog asks)
      checksIn, me: me ? { ...withAfterHours(me, cal), lateNoteNeeded: await needsLateNote(me) } : null,
      team: team && team.map((t) => ({ ...t, row: withAfterHours(t.row, cal) })),
      permissions: permReady ? { perMonth: att.permissionsPerMonth, mine: myPerms, left: Math.max(0, att.permissionsPerMonth - myPerms.length) } : null,
      leave: leaveOn ? {
        year, counting: !!leaveRules(att).countingSince, balance: myBal.get(caller.editorId) ?? null,
        waiting: myWaiting.rows[0].n, teamWaiting: teamWaiting.rows[0].n, canApprove: approver,
      } : null,
    });
  } catch (err) { next(err); }
});

// POST /attendance/check-in { plan } — Start day: check in, classify on time /
// late, and open the work session (unlocks the app, like Start Work did).
// Outside office hours (past closing, or a day the office is closed) it waits
// for a yes first: 428 with what starting now means, then again with
// { outsideHours: true }. (Not 409: the app takes that as "no attendance yet".)
attendanceRouter.post("/attendance/check-in", async (req, res, next) => {
  const parsed = z.object({ plan: z.string().trim().max(1000).optional(), outsideHours: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That plan couldn't be read." });
  try {
    if (!(await ready(res))) return;
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { cal, att } = await readSettings(req.orgId);
    const today = istNow();
    const existing = await rowFor(caller.editorId, today.ymd);
    const outside = outsideHoursNow(cal, today);
    if (outside && !parsed.data.outsideHours) {
      return res.status(428).json({ error: outsideWords(outside, existing, att), outsideHours: outside });
    }
    const { session } = await startSession(req.orgId, caller.editorId);
    const plan = parsed.data.plan || null;
    if (existing?.checkInAt) {
      // Already in today — Start day again after closing it reopens the day.
      await pool.query(
        "update attendance set plan_note = coalesce($2, plan_note), check_out_at = null, updated_at = now() where id = $1",
        [existing.id, plan],
      );
      const again = await rowFor(caller.editorId, today.ymd);
      return res.json({ attendance: withAfterHours(again, cal), session, lateNoteNeeded: await needsLateNote(again) });
    }
    const at = session?.startedAt ?? new Date();
    const c = classify(at, today.ymd, cal, att);
    // in after closing: the office hours were missed (absent), and a day of leave stays leave
    const after = !!afterHoursOf(cal, today.ymd, at);
    const checkIn = (q) => q.query(
      `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes, plan_note)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (editor_id, date) do update set
         check_in_at = excluded.check_in_at,
         status = case when (attendance.marked_by is not null and attendance.status in ('on_time', 'half_day', 'absent'))
                         or (attendance.auto_marked and attendance.status in ('absent', 'half_absent'))
                         or ($8::boolean and attendance.status in ('leave', 'half_day'))
                       then attendance.status else excluded.status end,
         late_minutes = case when $8::boolean and attendance.status in ('leave', 'half_day') then attendance.late_minutes else excluded.late_minutes end,
         auto_marked = attendance.auto_marked and attendance.status in ('absent', 'half_absent'),
         marked_by = case when attendance.status = 'leave' and not $8::boolean then null else attendance.marked_by end,
         plan_note = coalesce(excluded.plan_note, attendance.plan_note), updated_at = now()
       where attendance.check_in_at is null`,
      [req.orgId, caller.editorId, today.ymd, at, c.status, c.lateMinutes, plan, after],
    );
    // on a whole day of approved leave: checked in, given back and on time, all at once
    // (not after closing: the leave covered the office hours)
    const leaveDay = !after && existing?.status === "leave" && !!existing.leaveRequestId;
    // after the half-day time only the afternoon goes back (the morning stays leave)
    const afterHalf = att.halfDayReady !== false && today.minutes >= minutesOf(att.halfDayAt);
    const worked = leaveDay ? await workedLeaveDay(existing, checkIn, { afterHalf }) : null;
    if (!leaveDay) await checkIn(pool);
    if (existing?.status === "leave" && existing?.markedBy && !after) await leaveWorked(req, caller.editorId, today.ymd, !!worked, afterHalf);
    // a half day of leave: judged on the half they work
    const now = await rowFor(caller.editorId, today.ymd);
    if (now?.status === "half_day" && now.leaveRequestId) await judgeHalfDay(pool, now.id, cal, att);
    // (a leave day worked after all isn't late with a permission: no permission is used,
    // nor one after closing — a morning permission doesn't cover the whole day)
    if (!worked && !after) await applyMorningPermission(req.orgId, caller.editorId, today.ymd, att, req.user.sub);
    const row = await rowFor(caller.editorId, today.ymd);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "attendance_check_in", entityType: "editor", entityId: caller.editorId,
      summary: after ? `Started their day after office hours, at ${clockOf(new Date(at))}`
        : row.status === "late" ? `Started their day ${row.lateMinutes}m late` : "Started their day",
      meta: { date: today.ymd, status: row.status, ...(after ? { afterHours: true } : {}) },
    });
    // a late start: the app asks why at once (POST /attendance/late-reason) — after
    // closing, why they weren't in during office hours
    res.status(201).json({ attendance: withAfterHours(row, cal), session, penalty: penaltyOf(row, att), lateNoteNeeded: await needsLateNote(row) });
  } catch (err) { next(err); }
});

// POST /attendance/late-reason { note } — why today's start was late. The app
// asks as soon as Start day lands after the grace period; the lead sees it on
// Team today, Team › Attendance and in their activity.
attendanceRouter.post("/attendance/late-reason", async (req, res, next) => {
  const parsed = z.object({ note: z.string().trim().min(2).max(300) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Write a few words about why you started late." });
  try {
    if (!(await ready(res))) return;
    if (!(await lateNoteReady())) {
      return res.status(409).json({ error: "Late reasons need a database update first — ask whoever runs the database to apply 20261102120000_attendance_late_note." });
    }
    const caller = await callerScope(req);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const today = istNow();
    const row = await rowFor(caller.editorId, today.ymd);
    if (!row?.checkInAt) return res.status(400).json({ error: "You haven't started your day." });
    await pool.query("update attendance set late_note = $2, updated_at = now() where id = $1", [row.id, parsed.data.note]);
    const { cal } = await readSettings(req.orgId);
    const after = afterHoursOf(cal, today.ymd, row.checkInAt);
    const how = row.status === "absent" ? "late (counts as absent)"
      : row.status === "half_absent" ? "late (half-day absent)"
      : row.excused && row.reason === "permission" ? `${lateWords(row.lateMinutes)} late (morning permission)`
      : row.lateMinutes ? `${lateWords(row.lateMinutes)} late` : "late";
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "attendance_late_reason", entityType: "editor", entityId: caller.editorId,
      summary: after
        ? `Not in during office hours — started at ${clockOf(new Date(row.checkInAt))}${row.status === "absent" ? ", counts as absent" : ""}: “${parsed.data.note}”`
        : `Started ${how}: “${parsed.data.note}”`,
      meta: { date: today.ymd, status: row.status },
    });
    res.json({ attendance: withAfterHours(await rowFor(caller.editorId, today.ymd), cal) });
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
    // A day of approved leave worked after all: it's leave again (and comes off
    // the balance again).
    if (row.leaveRequestId && (await restoreLeaveDay(row))) {
      return res.json({ attendance: await rowFor(caller.editorId, today.ymd) });
    }
    // a second tap at the same moment: the first one has already undone it
    const cur = await rowFor(caller.editorId, today.ymd);
    if (!cur?.checkInAt) return res.json({ attendance: cur });
    // A lead's mark (working now, leave, half day, absent) stays; otherwise the
    // day goes back to what the clock says — and an excuse goes with the late
    // start (a morning permission it used is given back).
    const { cal, att } = await readSettings(req.orgId);
    const leadMark = !!cur.markedBy && !cur.excused && ["on_time", "leave", "half_day", "absent", "half_absent"].includes(cur.status);
    if (cur.excused && cur.reason === "permission") await giveBackPermission(caller.editorId, today.ymd, "morning");
    const opens = !!openingFor(cal, today.ymd);
    const absent = att.autoAbsentEnabled && opens && today.minutes >= minutesOf(att.autoAbsentAt);
    const halfAbsent = !absent && att.autoAbsentEnabled && att.halfDayReady !== false && opens && today.minutes >= minutesOf(att.halfDayAt);
    const alerted = today.minutes >= minutesOf(att.noSodAlertAt);
    // the late reason goes with the start it explained
    const noNote = (await lateNoteReady()) ? ", late_note = null" : "";
    if (leadMark) {
      await pool.query(`update attendance set check_in_at = null, late_minutes = 0${noNote}, updated_at = now() where id = $1 and check_in_at is not null`, [cur.id]);
    } else if (absent || halfAbsent || alerted || cur.planNote || cur.correctionStatus) {
      await pool.query(
        `update attendance set check_in_at = null, late_minutes = 0, excused = false, reason = null, marked_by = null${noNote},
           status = $2, auto_marked = $3, updated_at = now() where id = $1 and check_in_at is not null`,
        [cur.id, absent ? "absent" : halfAbsent ? "half_absent" : "no_sod", absent || halfAbsent],
      );
    } else {
      await pool.query("delete from attendance where id = $1 and check_in_at is not null", [cur.id]);
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
    const checkIn = (q) => q.query(
      `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes, correction_at, correction_note, correction_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       on conflict (editor_id, date) do update set
         check_in_at = coalesce(attendance.check_in_at, excluded.check_in_at),
         status = case when attendance.check_in_at is not null then attendance.status else case when (attendance.marked_by is not null and attendance.status in ('on_time', 'half_day', 'absent'))
                         or (attendance.auto_marked and attendance.status in ('absent', 'half_absent'))
                       then attendance.status else excluded.status end end,
         late_minutes = case when attendance.check_in_at is not null then attendance.late_minutes else excluded.late_minutes end,
         marked_by = case when attendance.status = 'leave' and attendance.check_in_at is null then null else attendance.marked_by end,
         auto_marked = false, correction_at = excluded.correction_at, correction_note = excluded.correction_note,
         correction_status = 'pending', updated_at = now()`,
      [req.orgId, caller.editorId, today.ymd, now, c.status, c.lateMinutes, asked, parsed.data.note || null],
    );
    // in on a whole day of approved leave: a working day, given back to the balance, at once
    if (already?.status === "leave" && already.leaveRequestId && !already.checkInAt) {
      const afterHalf = att.halfDayReady !== false && today.minutes >= minutesOf(att.halfDayAt);
      const worked = await workedLeaveDay(already, checkIn, { afterHalf });
      if (already.markedBy) await leaveWorked(req, caller.editorId, today.ymd, !!worked, afterHalf);
    } else {
      await checkIn(pool);
    }
    const nowRow = await rowFor(caller.editorId, today.ymd);
    if (nowRow?.status === "half_day" && nowRow.leaveRequestId) await judgeHalfDay(pool, nowRow.id, cal, att);
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
async function leaveWorked(req, editorId, ymd, givenBack = false, half = false) {
  const { rows: who } = await pool.query("select name from editor where id = $1", [editorId]);
  await logActivity({
    orgId: req.orgId, actorId: req.user.sub, verb: "attendance_leave_worked", entityType: "editor", entityId: editorId,
    summary: givenBack
      ? half
        ? `${who[0]?.name ?? "Someone"} checked in on a day of approved leave after the half-day time: the morning stays leave, the afternoon goes back to their balance.`
        : `${who[0]?.name ?? "Someone"} checked in on a day of approved leave, so it's a working day and goes back to their balance.`
      : `${who[0]?.name ?? "Someone"} checked in on a day marked as leave, so it counts as a working day. Mark leave again if that's right.`,
    meta: { date: ymd },
  });
}
// A clock time on India time, 12-hour (for messages).
function clockOf(d) {
  const t = new Date(d.getTime() + 330 * 60_000);
  const h = t.getUTCHours();
  return `${h % 12 || 12}:${String(t.getUTCMinutes()).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
// "18:00" → "6:00 PM"
const clockOfHHMM = (hhmm) => clockOf(new Date(`1970-01-01T${String(hhmm).padStart(5, "0")}:00+05:30`));
// A row with afterHours: the closing time when it started after closing, else null.
const withAfterHours = (row, cal) => (row ? { ...row, afterHours: afterHoursOf(cal, row.date ?? istNow().ymd, row.checkInAt) } : row);
// Start day outside office hours: what the "continue?" says starting now means.
function outsideWords(outside, existing, att) {
  const first = outside.closedToday ? "The office is closed today." : `The office closed at ${clockOfHHMM(outside.closedAt)}.`;
  if (existing?.checkInAt) return `${first} Do you want to start again and keep working outside office hours?`;
  if (outside.closedToday) return `${first} Do you want to work on your day off?`;
  const what = existing?.status === "leave" ? "Today stays as your leave."
    : existing?.status === "half_day" ? "The half you were meant to work counts as missed."
    : att.autoAbsentEnabled ? "Today counts as absent, and you'll be asked why you weren't in during office hours."
    : "It counts as a late start, and you'll be asked why.";
  return `${first} Starting now is work outside office hours. ${what} Do you want to continue?`;
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
    // leave or a half day: CL or SL, and which half (leave.js)
    type: z.enum(["CL", "SL"]).optional(),
    half: z.enum(["first", "second"]).optional(),
    reason: z.string().trim().max(300).optional(),
    // a CL the person told the manager about in time: no short-notice cut
    toldInTime: z.boolean().optional(),
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
    }
    if (parsed.data.as === "leave") {
      const { rows: worked } = await pool.query("select 1 from attendance where editor_id = $1 and date = $2 and check_in_at is not null", [t.editorId, day]);
      if (worked.length) return res.status(409).json({ error: `${t.name} checked in ${day === t.today.ymd ? "today" : "that day"}, so it can't be a full day of leave. Mark a half day instead.` });
    }
    // only working days (not Sundays, a Saturday off, or a holiday)
    const { cal, att } = await readSettings(req.orgId);
    if (!openingFor(cal, day)) return res.status(400).json({ error: "That isn't a working day." });
    const leaveOn = await leaveReady();
    if (leaveOn) {
      // a day of approved leave is changed by taking it off first (Undo), so the
      // day goes back to their CL or SL
      const cur = await rowFor(t.editorId, day);
      if (cur?.leaveRequestId && (cur.status === "leave" || cur.status === "half_day")) {
        return res.status(409).json({ error: `${t.name} is on approved leave ${day === t.today.ymd ? "today" : "that day"}. Undo it first — the day goes back to their CL or SL.` });
      }
    }
    if ((parsed.data.as === "leave" || parsed.data.as === "half_day") && leaveOn) {
      if (!leaveRules(att).countingSince) return res.status(409).json({ error: "Leave opens once a manager has set everyone's allowance and started counting (My Team › Leave)." });
      // Leave is CL or SL from the person's balance: an approved request, made
      // by a manager (their mark is the asking, so a CL's notice counts from
      // today). A half day: the first half unless they're in already.
      if (!isApprover(t.caller)) return res.status(403).json({ error: "Only a manager marks leave: it uses the person's CL or SL." });
      if (!parsed.data.type) return res.status(400).json({ error: "Pick CL or SL." });
      const row = await rowFor(t.editorId, day);
      const half = parsed.data.as === "half_day" ? parsed.data.half ?? (row?.checkInAt ? "second" : "first") : "full";
      try {
        const [made] = await createLeave({
          orgId: req.orgId, editorId: t.editorId, type: parsed.data.type, from: day, to: day, half, reason: parsed.data.reason,
          askedBy: req.user.sub, approvedBy: req.user.sub, toldInTime: !!parsed.data.toldInTime, cal, rules: leaveRules(att), today: t.today.ymd,
        });
        const told = parsed.data.toldInTime && made.type === "CL";
        await audit(req, t, "leave_approved",
          `Marked ${t.name}: ${requestWords(made)}${made.short ? " · short notice" : ""}${told ? " · they told us in time (no short-notice cut)" : ""}${made.unpaid ? ` · ${made.unpaid} unpaid` : ""}`,
          { leaveId: made.id, date: day, toldInTime: !!told });
      } catch (err) {
        if (err instanceof LeaveError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      return res.json({ attendance: await rowFor(t.editorId, day) });
    }
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
      if (other.leaveRequestId) {
        if (!isApprover(t.caller)) return res.status(403).json({ error: "Only a manager takes leave off: it goes back to their CL or SL." });
        await dropLeaveDay(other, t.today.ymd);
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
    if (row.leaveRequestId && (row.status === "leave" || row.status === "half_day")) {
      if (!isApprover(t.caller)) return res.status(403).json({ error: "Only a manager takes leave off: it goes back to their CL or SL." });
      await dropLeaveDay(row, t.today.ymd);
    }
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
  } catch (err) {
    // a leave day in a month Management Performance has closed
    if (err instanceof LeaveError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
    date: z.string().refine(validYmd),
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

// GET /attendance/permissions/mine — your permissions this month and ahead
// (the Attendance panel's Permission tab): how many a month, how many left
// this month, and each one (waiting, approved, used, declined).
attendanceRouter.get("/attendance/permissions/mine", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    if (!(await permissionsReady())) return res.json({ ready: false });
    const [caller, { att }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    const today = istNow().ymd;
    if (!caller.editorId) return res.json({ ready: true, linked: false, perMonth: att.permissionsPerMonth, left: 0, today, mine: [] });
    const [{ rows: mine }, month] = await Promise.all([
      pool.query(
        `select id, date::text as date, part, status, emergency, note, created_at as "createdAt" from attendance_permission
          where editor_id = $1 and date >= date_trunc('month', $2::date) order by date desc, part`,
        [caller.editorId, today],
      ),
      permissionsThisMonth(caller.editorId, today),
    ]);
    res.json({
      ready: true, linked: true, today, perMonth: att.permissionsPerMonth, left: Math.max(0, att.permissionsPerMonth - month.length),
      halfDayAt: att.halfDayAt, mine,
    });
  } catch (err) { next(err); }
});

// POST /attendance/permission/:id/cancel — take back your own permission: one
// still waiting, or an approved one for a day ahead. It counts again.
attendanceRouter.post("/attendance/permission/:id/cancel", async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "Permission not found." });
  try {
    if (!(await ready(res))) return;
    if (!(await permissionsReady())) return res.status(409).json({ error: "Permissions need a database update first." });
    const caller = await callerScope(req);
    const { rows } = await pool.query(
      "select id, date::text as date, part, status from attendance_permission where id = $1 and org_id = $2 and editor_id = $3",
      [req.params.id, req.orgId, caller.editorId],
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ error: "Permission not found." });
    const today = istNow().ymd;
    if (!(p.status === "requested" || (p.status === "approved" && p.date > today))) {
      return res.status(409).json({ error: p.status === "used" ? "It's been used already." : p.status === "declined" ? "It was declined." : "It's for today — ask your lead." });
    }
    await pool.query("delete from attendance_permission where id = $1", [p.id]);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "attendance_permission_cancelled", entityType: "editor", entityId: caller.editorId,
      summary: `${caller.name ?? "Someone"} cancelled their ${p.part} permission on ${p.date}`, meta: { date: p.date, part: p.part },
    });
    res.json({ ok: true });
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
  const parsed = z.object({ approve: z.boolean(), date: z.string().refine(validYmd).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Approve or decline." });
  try {
    const t = await leadTarget(req, res);
    if (!t) return;
    // the day asked about, or the latest one waiting — from today or the few
    // days before (asked late in the day, answered the next)
    const { rows: waiting } = await pool.query(
      `select date::text as day from attendance
        where editor_id = $1 and correction_status = 'pending' and date >= $2::date - 3 and date <= $2::date
          and ($3::date is null or date = $3::date)
        order by date desc limit 1`,
      [t.editorId, t.today.ymd, parsed.data.date ?? null],
    );
    // the day asked about isn't waiting any more (answered from another Inbox): say so
    if (parsed.data.date && !waiting[0]) return res.status(409).json({ error: "That correction has already been answered." });
    const day = waiting[0]?.day ?? t.today.ymd;
    const row = await rowFor(t.editorId, day);
    if (!row || row.correctionStatus !== "pending") return res.status(400).json({ error: "There's no correction waiting." });
    if (parsed.data.approve) {
      const { cal, att } = await readSettings(req.orgId);
      const c = classify(row.correctionAt, day, cal, att);
      // a lead's mark stays, and so does a day of leave worked after all (on time)
      const keep = (row.markedBy && ["on_time", "leave", "half_day", "absent", "half_absent"].includes(row.status)) || row.reason === WORKED;
      await pool.query(
        `update attendance set check_in_at = correction_at, status = $2, late_minutes = $3,
           correction_status = 'approved', updated_at = now() where id = $1`,
        [row.id, keep ? row.status : c.status, row.reason === WORKED ? 0 : c.lateMinutes],
      );
      if (row.status === "half_day" && row.leaveRequestId) await judgeHalfDay(pool, row.id, cal, att);
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
    // Echo's own marks (the no-SOD alert, auto-absent) are applied at most
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
      ? await pool.query(`select ${await rowCols()} from attendance where editor_id = any($1::uuid[]) and to_char(date, 'YYYY-MM') = $2`, [ids, month])
      : { rows: [] };
    const byKey = new Map(rows.map((r) => [`${r.editorId}|${r.date}`, r]));
    const leavePts = await leavePenalties(req.orgId, month);
    const c = normalizeCalendar(cal);
    const dayMin = Math.max(0, minutesOf(c.wdTo) - minutesOf(c.wdFrom) - LUNCH_MIN - TEA_MIN);
    let absences = 0;
    const out = shown.map((p) => {
      let late = 0, absent = 0, leave = 0, onTime = 0, pts = leavePts.get(p.id) ?? 0;
      const leaveBy = { CL: 0, SL: 0, unpaid: 0 };
      const cells = days.map((d) => {
        const r = byKey.get(`${p.id}|${d.date}`) ?? null;
        if (!d.working || d.future) return { status: null, row: null };
        const s = r ? shownStatus(r) : d.today ? "waiting" : null;
        if (r) {
          if (r.status === "late" && !r.excused) late++;
          else if (r.status === "on_time" || (r.status === "late" && r.excused)) onTime++;
          if (r.status === "absent") absent++;
          if (r.status === "half_absent") absent += 0.5;
          // a half day of leave: the half they work, missed or late
          if (r.status === "half_day" && r.leaveRequestId) {
            if (r.autoMarked) absent += 0.5;
            else if (r.lateMinutes > 0 && !r.excused) late++;
          }
          if (r.status === "leave" || r.status === "half_day") {
            const n = r.status === "leave" ? 1 : 0.5;
            leave += n;
            if (r.reason === "CL" || r.reason === "SL" || r.reason === "unpaid") leaveBy[r.reason] += n;
          }
          pts += penaltyOf(r, att);
        }
        return {
          status: s,
          row: r ? {
            checkInAt: r.checkInAt, lateMinutes: r.lateMinutes, excused: r.excused, reason: r.reason, autoMarked: r.autoMarked,
            lateNote: r.lateNote ?? null,
          } : null,
        };
      });
      absences += absent;
      const present = onTime + late;
      return {
        editorId: p.id, name: p.name, imageUrl: p.imageUrl, designation: p.designation, cells,
        totals: { late, absent, leave, leaveBy, onTimePct: present ? Math.round((onTime / present) * 100) : null, ptsLost: pts },
      };
    });
    const cap = capacityFor(cal, y, m - 1);
    res.json({
      month, days, rows: out, settings: att, scope: caller.scope,
      // a manager marks leave (CL / SL from the person's balance)
      canMarkLeave: (await leaveReady()) && isApprover(caller) && !!leaveRules(att).countingSince,
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
      `select ${await rowCols()} from attendance where editor_id = $1 order by date desc limit 62`, [caller.editorId],
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

