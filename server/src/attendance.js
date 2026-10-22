import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { isOrgAdmin } from "./permissions.js";
import { logActivity } from "./activity.js";
import { normalizeCalendar } from "./work-calendar.js";
import { LEAVE_DEFAULTS } from "./leave-math.js";

// Attendance — Start of day check-in and the late / no-SOD / absent rules.
// Office hours come from the work calendar (Settings › General); the rules
// from Settings › Attendance (org.settings.attendance). Everything runs on
// India time. The server sleeps when idle, so nothing waits on a timer: the
// no-SOD alert and the auto-absent mark are applied the first time Pulse is
// used after their time (syncAttendance), the same way a forgotten End Work is
// closed. See migration 20261025120000_attendance.sql.

export const ATTENDANCE_DEFAULTS = {
  requireSod: true,
  graceMinutes: 10,
  noSodAlertAt: "09:30",
  // Not in by halfDayAt: a half-day absence (half the absence penalty); still
  // not in by autoAbsentAt: absent. A morning permission covers being late up
  // to halfDayAt.
  halfDayAt: "11:30",
  autoAbsentAt: "13:30",
  autoAbsentEnabled: true,
  // Permissions a month (morning: come in late; evening: leave early).
  permissionsPerMonth: 2,
  requireEodNote: true,
  allowCorrections: true,
  latePenaltyPts: 1,
  absentPenaltyPts: 3,
  deductCapacity: true,
  // Who besides admins sees the whole team's attendance (Team today, Team ›
  // Attendance, the lead actions), by position. Only a Super Admin changes it.
  teamView: { manager: true, asstManager: true, teamLead: true },
  // Leave (leave-math.js): CL notice in working days, the short-notice cut a
  // request, the cut a day for unpaid leave, and when counting started (a
  // manager presses Start counting once the starting allowances are set).
  leave: LEAVE_DEFAULTS,
};

export function normalizeAttendance(a) {
  const src = a && typeof a === "object" ? a : {};
  const s = { ...ATTENDANCE_DEFAULTS, ...src, teamView: { ...ATTENDANCE_DEFAULTS.teamView, ...(src.teamView && typeof src.teamView === "object" ? src.teamView : {}) } };
  s.leave = { ...LEAVE_DEFAULTS, ...(src.leave && typeof src.leave === "object" ? src.leave : {}) };
  delete s.leaveLog;
  // Saved before the half-day rule: its auto-absent time gives way to the new
  // pair (half day at 11:30 AM, absent at 1:30 PM).
  if (src.halfDayAt == null) { s.halfDayAt = ATTENDANCE_DEFAULTS.halfDayAt; s.autoAbsentAt = ATTENDANCE_DEFAULTS.autoAbsentAt; }
  delete s.since;
  delete s.penaltyLog;
  return s;
}

// The position's key in teamView, or null for everyone else.
export function positionKey(designation) {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "manager") return "manager";
  if (p === "asst. manager" || p === "assistant manager") return "asstManager";
  if (p === "team lead") return "teamLead";
  return null;
}

export const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

// India time (UTC+5:30, no daylight saving).
const IST_MS = 330 * 60_000;
export function istNow(d = new Date()) {
  const t = new Date(d.getTime() + IST_MS);
  return { ymd: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
}
export const istYmd = (d) => istNow(new Date(d)).ymd;
export const istMinutes = (d) => istNow(new Date(d)).minutes;
// "HH:MM" on an IST date → a Date.
export const istAt = (ymd, hhmm) => new Date(`${ymd}T${String(hhmm).padStart(5, "0")}:00+05:30`);
export function weekdayOf(ymd) {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

// Office opening on a date ("HH:MM"), or null when the office is closed
// (Sundays, and Saturdays when they're off).
export function openingFor(cal, ymd) {
  const c = normalizeCalendar(cal);
  const w = weekdayOf(ymd);
  if (w === 0 || c.holidays.includes(ymd)) return null;
  if (w === 6) return c.satOff ? null : c.satFrom;
  return c.wdFrom;
}
export function closingFor(cal, ymd) {
  const c = normalizeCalendar(cal);
  const w = weekdayOf(ymd);
  if (w === 0 || c.holidays.includes(ymd)) return null;
  if (w === 6) return c.satOff ? null : c.satTo;
  return c.wdTo;
}

// The org's settings, kept for a few seconds: one page load reads them from
// several requests (each a trip to the remote database). Saving them
// (routes/org.js, routes/home.js) clears this at once.
const settingsCache = new Map(); // orgId -> { v, exp }
const SETTINGS_TTL_MS = 10_000;
export function clearSettingsCache(orgId) {
  if (orgId) settingsCache.delete(orgId); else settingsCache.clear();
}
export async function readSettings(orgId) {
  if (!(await hasColumn("org", "settings"))) return { cal: normalizeCalendar(null), att: normalizeAttendance(null), since: null, raw: {} };
  const hit = settingsCache.get(orgId);
  if (hit && hit.exp > Date.now()) return hit.v;
  const { rows } = await pool.query("select settings from org where id = $1", [orgId]);
  const s = rows[0]?.settings ?? {};
  const v = { cal: normalizeCalendar(s.calendar), att: normalizeAttendance(s.attendance), since: s.attendance?.since ?? null, raw: s };
  // "Half day absent" needs the database change (20261029120000); until it's
  // in, the old rule holds: late until the absent time.
  v.att.halfDayReady = await permissionsReady();
  settingsCache.set(orgId, { v, exp: Date.now() + SETTINGS_TTL_MS });
  return v;
}

export const attendanceReady = () => hasColumn("attendance", "id");

// Home role from the position (Team › Roster): Manager and Asst. Manager get
// the Manager Home, Team Lead the Team lead Home, everyone else the Editor
// Home; an admin whose position isn't Editor or Viewer (none, or an older
// title) counts as a Manager. Mirrors pulse-app/src/lib/home-role.ts.
export function homeRoleOf(designation, isAdmin) {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "manager" || p === "asst. manager" || p === "assistant manager") return "manager";
  if (p === "team lead") return "lead";
  if (isAdmin && p !== "editor" && p !== "viewer") return "manager";
  return "editor";
}

// The caller: their roster person, Home role and what they can see.
//   scope "all"  — admins, and managers / asst. managers / team leads whose
//                  position Settings › Attendance lets see the team
//   scope "self" — everyone else (their own day only)
export async function callerScope(req) {
  const { rows } = await pool.query(
    `select u.editor_id, e.designation, e.name from app_user u left join editor e on e.id = u.editor_id where u.id = $1`,
    [req.user.sub],
  );
  const editorId = rows[0]?.editor_id ?? null;
  const admin = req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
  const role = homeRoleOf(rows[0]?.designation, admin);
  const key = positionKey(rows[0]?.designation);
  const { att } = await readSettings(req.orgId);
  const scope = admin || (key && att.teamView[key]) ? "all" : "self";
  return { editorId, role, admin, scope, name: rows[0]?.name ?? null };
}

// Can this caller act on (or see) that person's attendance?
export async function canSee(caller, editorId) {
  if (caller.scope === "all") return true;
  return !!caller.editorId && editorId === caller.editorId;
}

// Who checks in: active team members with an active login who can work
// (editor or admin somewhere in the org) and whose Home role isn't Manager.
export async function attendancePeople(orgId) {
  const withLead = await hasColumn("editor", "lead_editor_id");
  const { rows } = await pool.query(
    `select e.id, e.name, e.designation, e.image_url as "imageUrl",
            ${withLead ? "e.lead_editor_id" : "null::uuid"} as "leadEditorId",
            bool_or(m.role = 'admin') as "isAdmin",
            bool_or(m.role in ('admin', 'editor')) as "canWork"
       from editor e
       join app_user u on u.editor_id = e.id and u.active
       join membership m on m.user_id = u.id
       join workspace w on w.id = m.workspace_id and w.org_id = e.org_id
      where e.org_id = $1 and e.active
      group by e.id
      order by e.name`,
    [orgId],
  );
  return rows.filter((r) => r.canWork && homeRoleOf(r.designation, r.isAdmin) !== "manager");
}

// A check-in, against the day's opening: on time within the grace, late until
// the half-day time, a half-day absence until the absent time, absent after
// (the last two only while automatic marks are on).
export function classify(checkInAt, ymd, cal, att) {
  const open = openingFor(cal, ymd);
  if (!open) return { status: "on_time", lateMinutes: 0 };
  const late = Math.max(0, Math.round((new Date(checkInAt).getTime() - istAt(ymd, open).getTime()) / 60_000));
  if (late <= att.graceMinutes) return { status: "on_time", lateMinutes: 0 };
  const at = istMinutes(checkInAt);
  if (att.autoAbsentEnabled && at >= minutesOf(att.autoAbsentAt)) return { status: "absent", lateMinutes: late };
  if (att.autoAbsentEnabled && att.halfDayReady !== false && at >= minutesOf(att.halfDayAt)) return { status: "half_absent", lateMinutes: late };
  return { status: "late", lateMinutes: late };
}

// Penalty points a day's row costs, under the current settings.
export function penaltyOf(row, att) {
  if (!row) return 0;
  if (row.status === "late" && !row.excused) return att.latePenaltyPts;
  if (row.status === "absent") return att.absentPenaltyPts;
  if (row.status === "half_absent") return att.absentPenaltyPts / 2;
  return 0;
}

// ---- Permission (migration 20261029120000_attendance_permission) ----
export async function permissionsReady() {
  return hasColumn("attendance_permission", "id");
}
// Permissions counted against the month's allowance: asked for (waiting),
// approved, or used. Declined ones don't count.
export async function permissionsThisMonth(editorId, ymd) {
  if (!(await permissionsReady())) return [];
  const { rows } = await pool.query(
    `select id, date::text as date, part, status, emergency, note from attendance_permission
      where editor_id = $1 and date >= date_trunc('month', $2::date) and date < date_trunc('month', $2::date) + interval '1 month'
        and status <> 'declined' order by date, part`,
    [editorId, ymd],
  );
  return rows;
}
async function usePermission(orgId, editorId, ymd, part, att, actorId, verbWord) {
  if (!(await permissionsReady())) return null;
  const month = await permissionsThisMonth(editorId, ymd);
  const own = month.find((p) => p.date === ymd && p.part === part);
  if (own?.status === "used") return own;
  // an approved (or waiting) one for this day is used now; otherwise one is
  // taken from what's left, as an emergency
  if (!own && month.length >= att.permissionsPerMonth) return null;
  const { rows } = await pool.query(
    `insert into attendance_permission (org_id, editor_id, date, part, status, emergency, asked_by)
     values ($1, $2, $3, $4, 'used', true, $5)
     on conflict (editor_id, date, part) do update set status = 'used'
     returning id, status, emergency`,
    [orgId, editorId, ymd, part, actorId],
  );
  const left = Math.max(0, att.permissionsPerMonth - (own ? month.length : month.length + 1));
  const { rows: who } = await pool.query("select name from editor where id = $1", [editorId]);
  await logActivity({
    orgId, actorId, verb: "attendance_permission_used", entityType: "editor", entityId: editorId,
    summary: `${who[0]?.name ?? "Someone"} ${verbWord} with a ${part} permission${own ? "" : " (not asked ahead)"} · ${left} left this month`,
    meta: { date: ymd, part, left },
  });
  return rows[0];
}
// Start day undone: a permission it used goes back (one taken on the day is
// gone; one asked ahead is approved again). `q`: a transaction's client.
export async function giveBackPermission(editorId, ymd, part, q = pool) {
  if (!(await permissionsReady())) return;
  await q.query("delete from attendance_permission where editor_id = $1 and date = $2 and part = $3 and status = 'used' and emergency", [editorId, ymd, part]);
  await q.query("update attendance_permission set status = 'approved' where editor_id = $1 and date = $2 and part = $3 and status = 'used'", [editorId, ymd, part]);
}
// A late start before the half-day time: a permission covers it (no late mark)
// while one is left this month, or if one was approved for the morning.
export async function applyMorningPermission(orgId, editorId, ymd, att, actorId) {
  const { rows } = await pool.query("select id, status, excused from attendance where editor_id = $1 and date = $2", [editorId, ymd]);
  const row = rows[0];
  if (!row || row.status !== "late" || row.excused) return false;
  const used = await usePermission(orgId, editorId, ymd, "morning", att, actorId, "came in late");
  if (!used) return false;
  await pool.query("update attendance set excused = true, reason = 'permission', updated_at = now() where id = $1", [row.id]);
  return true;
}
// Ending the day early (15 minutes or more before closing): recorded as an
// evening permission while one is left, or if one was approved.
export async function applyEveningPermission(orgId, editorId, ymd, cal, att, actorId) {
  const close = closingFor(cal, ymd);
  if (!close) return false;
  if (istNow().minutes > minutesOf(close) - 15) return false;
  // a half day (or day) of leave already covers leaving early
  const { rows } = await pool.query("select status from attendance where editor_id = $1 and date = $2", [editorId, ymd]);
  if (["leave", "half_day"].includes(rows[0]?.status)) return false;
  return !!(await usePermission(orgId, editorId, ymd, "evening", att, actorId, "left early"));
}

// Points lost per person in a month ("YYYY-MM") — fed into the discipline
// score (Goals, Management Performance).
// The penalty points a month is charged at: the settings it had, not today's.
// Settings › Attendance keeps a log of changes (penaltyLog: [{ from: "YYYY-MM",
// late, absent }]); a month uses the last entry from on or before it.
export function penaltiesFor(att, raw, month) {
  const log = Array.isArray(raw?.attendance?.penaltyLog) ? raw.attendance.penaltyLog : [];
  const entry = log.filter((e) => e && String(e.from) <= month).sort((a, b) => String(a.from).localeCompare(String(b.from))).pop();
  return entry ? { ...att, latePenaltyPts: Number(entry.late), absentPenaltyPts: Number(entry.absent) } : att;
}
export async function monthPenalties(orgId, month) {
  if (!(await attendanceReady())) return new Map();
  const { att: now, raw } = await readSettings(orgId);
  const att = penaltiesFor(now, raw, month);
  const [{ rows }, leave] = await Promise.all([
    pool.query(
      `select editor_id, status, excused from attendance
        where org_id = $1 and to_char(date, 'YYYY-MM') = $2`,
      [orgId, month],
    ),
    leavePenalties(orgId, month),
  ]);
  const m = new Map(leave);
  for (const r of rows) m.set(r.editor_id, (m.get(r.editor_id) ?? 0) + penaltyOf(r, att));
  return m;
}
// Approved leave's points (short notice, unpaid days), in the month it starts —
// fixed when it was asked for (leave-math.js).
export async function leavePenalties(orgId, month) {
  const m = new Map();
  if (!(await hasColumn("leave_request", "penalty_pts"))) return m;
  const { rows } = await pool.query(
    `select editor_id, sum(penalty_pts)::float as pts from leave_request
      where org_id = $1 and status = 'approved' and to_char(date_from, 'YYYY-MM') = $2 group by editor_id`,
    [orgId, month],
  );
  for (const r of rows) if (r.pts) m.set(r.editor_id, r.pts);
  return m;
}

// The lazy "scheduled jobs": record check-ins made through Start Work, send
// the no-SOD alert once its time has passed, mark the day absent once the
// auto-absent time has passed, and fill in past working days nobody checked
// in on (from the day attendance was first used). At most once a minute per
// org per server.
const lastSync = new Map();
const lastBackfill = new Map();
export async function syncAttendance(orgId) {
  if (!orgId || !(await attendanceReady())) return;
  const now = Date.now();
  if (now - (lastSync.get(orgId) ?? 0) < 60_000) return;
  lastSync.set(orgId, now);
  try {
    const { cal, att, since } = await readSettings(orgId);
    const today = istNow();
    let start = since;
    if (!start) {
      start = today.ymd;
      if (await hasColumn("org", "settings")) {
        await pool.query(
          `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attendance}',
             coalesce(settings->'attendance', '{}'::jsonb) || jsonb_build_object('since', $2::text)) where id = $1`,
          [orgId, start],
        );
      }
    }
    const people = await attendancePeople(orgId);
    if (!people.length) return;
    const ids = people.map((p) => p.id);
    const nameOf = new Map(people.map((p) => [p.id, p.name]));

    // Started work some other way (Start Work, an older app): count it as the check-in.
    const { rows: started } = await pool.query(
      `select s.editor_id, min(s.started_at) as first
         from eod_session s
        where s.org_id = $1 and s.editor_id = any($2::uuid[])
          and (s.started_at at time zone 'Asia/Kolkata')::date = $3::date
        group by s.editor_id`,
      [orgId, ids, today.ymd],
    );
    for (const s of started) {
      const c = classify(s.first, today.ymd, cal, att);
      const { rows: before } = await pool.query(
        `select id, status, check_in_at, leave_request_id as "leaveRequestId" from attendance where editor_id = $1 and date = $2`,
        [s.editor_id, today.ymd],
      );
      const checkIn = (q) => q.query(
        `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (editor_id, date) do update set
           check_in_at = excluded.check_in_at,
           status = case when (attendance.marked_by is not null and attendance.status in ('on_time', 'half_day', 'absent'))
                           or (attendance.auto_marked and attendance.status in ('absent', 'half_absent'))
                         then attendance.status else excluded.status end,
           late_minutes = excluded.late_minutes,
           auto_marked = attendance.auto_marked and attendance.status in ('absent', 'half_absent'),
           marked_by = case when attendance.status = 'leave' then null else attendance.marked_by end,
           updated_at = now()
         where attendance.check_in_at is null`,
        [orgId, s.editor_id, today.ymd, s.first, c.status, c.lateMinutes],
      );
      // a whole day of approved leave worked after all: checked in, back to the
      // balance and on time, together
      const b = before[0];
      if (b && !b.check_in_at && b.status === "leave" && b.leaveRequestId) {
        const { workedLeaveDay } = await import("./leave.js");
        if (await workedLeaveDay(b, checkIn)) continue;
      } else {
        await checkIn(pool);
      }
      await applyMorningPermission(orgId, s.editor_id, today.ymd, att, null);
    }

    const open = openingFor(cal, today.ymd);
    if (open) {
      // No-SOD alert.
      if (today.minutes >= minutesOf(att.noSodAlertAt)) {
        const { rows: alerted } = await pool.query(
          `insert into attendance (org_id, editor_id, date, status, alert_sent_at)
           select $1, x, $3, 'no_sod', now() from unnest($2::uuid[]) x
           on conflict (editor_id, date) do update set alert_sent_at = now(), updated_at = now()
           where attendance.alert_sent_at is null and attendance.check_in_at is null
             and attendance.marked_by is null and attendance.status = 'no_sod'
           returning editor_id`,
          [orgId, ids, today.ymd],
        );
        for (const r of alerted) {
          await logActivity({
            orgId, actorId: null, verb: "attendance_no_sod", entityType: "editor", entityId: r.editor_id,
            summary: `${nameOf.get(r.editor_id) ?? "Someone"} hasn't started their day yet`,
            meta: { date: today.ymd },
          });
        }
      }
      // Not in by the half-day time: a half-day absence; still not in by the
      // absent time: absent. Only rows Pulse made (or none), never a lead's mark.
      const markFrom = att.halfDayReady !== false ? att.halfDayAt : att.autoAbsentAt;
      if (att.autoAbsentEnabled && today.minutes >= minutesOf(markFrom)) {
        const mark = today.minutes >= minutesOf(att.autoAbsentAt) ? "absent" : "half_absent";
        await pool.query(
          `insert into attendance (org_id, editor_id, date, status, auto_marked)
           select $1, x, $3, $4, true from unnest($2::uuid[]) x
           on conflict (editor_id, date) do update set status = excluded.status, auto_marked = true, updated_at = now()
           where attendance.check_in_at is null and attendance.marked_by is null
             and attendance.status in ('no_sod', 'half_absent') and attendance.status <> excluded.status`,
          [orgId, ids, today.ymd, mark],
        );
      }
    }

    // Past working days with no record: absent (or no SOD when auto-absent is
    // off), unless they worked that day. Once a day per org.
    if (lastBackfill.get(orgId) !== today.ymd && start < today.ymd) {
      lastBackfill.set(orgId, today.ymd);
      const days = [];
      for (let d = new Date(`${start}T12:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
        const ymd = d.toISOString().slice(0, 10);
        if (ymd >= today.ymd) break;
        if (openingFor(cal, ymd)) days.push(ymd);
        if (days.length > 400) break;
      }
      if (days.length) {
        // Each person only from the day they joined (their roster entry or
        // login, whichever is later): never absent before they were here.
        const { rows: joined } = await pool.query(
          `select e.id, (greatest(e.created_at, coalesce(max(u.created_at), e.created_at)) at time zone 'Asia/Kolkata')::date::text as day
             from editor e left join app_user u on u.editor_id = e.id
            where e.id = any($1::uuid[]) group by e.id, e.created_at`,
          [ids],
        );
        const joinedOn = new Map(joined.map((j) => [j.id, j.day]));
        const { rows: worked } = await pool.query(
          `select editor_id, (started_at at time zone 'Asia/Kolkata')::date::text as day, min(started_at) as first
             from eod_session where org_id = $1 and editor_id = any($2::uuid[])
              and (started_at at time zone 'Asia/Kolkata')::date = any($3::date[])
            group by 1, 2`,
          [orgId, ids, days],
        );
        const firstOf = new Map(worked.map((w) => [`${w.editor_id}|${w.day}`, w.first]));
        const { rows: have } = await pool.query(
          "select editor_id, date::text as day from attendance where org_id = $1 and date = any($2::date[])",
          [orgId, days],
        );
        const has = new Set(have.map((h) => `${h.editor_id}|${h.day}`));
        for (const ymd of days) {
          for (const id of ids) {
            const k = `${id}|${ymd}`;
            if (has.has(k)) continue;
            if (ymd < (joinedOn.get(id) ?? ymd)) continue;
            const first = firstOf.get(k);
            if (first) {
              const c = classify(first, ymd, cal, att);
              await pool.query(
                `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes)
                 values ($1, $2, $3, $4, $5, $6) on conflict (editor_id, date) do nothing`,
                [orgId, id, ymd, first, c.status, c.lateMinutes],
              );
            } else {
              await pool.query(
                `insert into attendance (org_id, editor_id, date, status, auto_marked)
                 values ($1, $2, $3, $4, true) on conflict (editor_id, date) do nothing`,
                [orgId, id, ymd, att.autoAbsentEnabled ? "absent" : "no_sod"],
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("syncAttendance failed:", err.message);
  }
}
