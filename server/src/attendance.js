import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { isOrgAdmin } from "./permissions.js";
import { logActivity } from "./activity.js";
import { normalizeCalendar } from "./work-calendar.js";

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
  autoAbsentAt: "11:00",
  autoAbsentEnabled: true,
  requireEodNote: true,
  allowCorrections: true,
  latePenaltyPts: 1,
  absentPenaltyPts: 3,
  deductCapacity: true,
};

export function normalizeAttendance(a) {
  const s = { ...ATTENDANCE_DEFAULTS, ...(a && typeof a === "object" ? a : {}) };
  delete s.since;
  return s;
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
  if (w === 0) return null;
  if (w === 6) return c.satOff ? null : c.satFrom;
  return c.wdFrom;
}
export function closingFor(cal, ymd) {
  const c = normalizeCalendar(cal);
  const w = weekdayOf(ymd);
  if (w === 0) return null;
  if (w === 6) return c.satOff ? null : c.satTo;
  return c.wdTo;
}

export async function readSettings(orgId) {
  if (!(await hasColumn("org", "settings"))) return { cal: normalizeCalendar(null), att: normalizeAttendance(null), since: null, raw: {} };
  const { rows } = await pool.query("select settings from org where id = $1", [orgId]);
  const s = rows[0]?.settings ?? {};
  return { cal: normalizeCalendar(s.calendar), att: normalizeAttendance(s.attendance), since: s.attendance?.since ?? null, raw: s };
}

export const attendanceReady = () => hasColumn("attendance", "id");

// Home role from the position (Team › Roster): Manager and Asst. Manager get
// the Manager Home, Team Lead the Team lead Home, everyone else the Editor
// Home; an admin with no position counts as a Manager. Mirrors
// pulse-app/src/lib/home-role.ts.
export function homeRoleOf(designation, isAdmin) {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "manager" || p === "asst. manager" || p === "assistant manager") return "manager";
  if (p === "team lead") return "lead";
  if (!p && isAdmin) return "manager";
  return "editor";
}

// The caller: their roster person, Home role and what they can see.
//   scope "all"  — managers and admins: everyone
//   scope "team" — team leads: people assigned to them
//   scope "self" — everyone else
export async function callerScope(req) {
  const withLead = await hasColumn("editor", "lead_editor_id");
  const { rows } = await pool.query(
    `select u.editor_id, e.designation, e.name from app_user u left join editor e on e.id = u.editor_id where u.id = $1`,
    [req.user.sub],
  );
  const editorId = rows[0]?.editor_id ?? null;
  const admin = req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
  const role = homeRoleOf(rows[0]?.designation, admin);
  const scope = admin || role === "manager" ? "all" : role === "lead" && editorId && withLead ? "team" : "self";
  return { editorId, role, admin, scope, name: rows[0]?.name ?? null };
}

// Can this caller act on (or see) that person's attendance?
export async function canSee(caller, editorId) {
  if (caller.scope === "all") return true;
  if (caller.editorId && editorId === caller.editorId) return true;
  if (caller.scope !== "team") return false;
  const { rows } = await pool.query("select 1 from editor where id = $1 and lead_editor_id = $2", [editorId, caller.editorId]);
  return rows.length > 0;
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

// on time / late for a check-in, against the day's opening and the grace.
export function classify(checkInAt, ymd, cal, att) {
  const open = openingFor(cal, ymd);
  if (!open) return { status: "on_time", lateMinutes: 0 };
  const late = Math.max(0, Math.round((new Date(checkInAt).getTime() - istAt(ymd, open).getTime()) / 60_000));
  return late <= att.graceMinutes ? { status: "on_time", lateMinutes: 0 } : { status: "late", lateMinutes: late };
}

// Penalty points a day's row costs, under the current settings.
export function penaltyOf(row, att) {
  if (!row) return 0;
  if (row.status === "late" && !row.excused) return att.latePenaltyPts;
  if (row.status === "absent") return att.absentPenaltyPts;
  return 0;
}

// Points lost per person in a month ("YYYY-MM") — fed into the discipline
// score (Goals, Management Performance).
export async function monthPenalties(orgId, month) {
  if (!(await attendanceReady())) return new Map();
  const { att } = await readSettings(orgId);
  const { rows } = await pool.query(
    `select editor_id, status, excused from attendance
      where org_id = $1 and to_char(date, 'YYYY-MM') = $2`,
    [orgId, month],
  );
  const m = new Map();
  for (const r of rows) m.set(r.editor_id, (m.get(r.editor_id) ?? 0) + penaltyOf(r, att));
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
      await pool.query(
        `insert into attendance (org_id, editor_id, date, check_in_at, status, late_minutes)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (editor_id, date) do update set
           check_in_at = excluded.check_in_at,
           status = case when attendance.marked_by is not null and attendance.status in ('on_time', 'leave', 'half_day')
                         then attendance.status else excluded.status end,
           late_minutes = excluded.late_minutes, auto_marked = false, updated_at = now()
         where attendance.check_in_at is null`,
        [orgId, s.editor_id, today.ymd, s.first, c.status, c.lateMinutes],
      );
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
      // Auto-absent.
      if (att.autoAbsentEnabled && today.minutes >= minutesOf(att.autoAbsentAt)) {
        await pool.query(
          `insert into attendance (org_id, editor_id, date, status, auto_marked)
           select $1, x, $3, 'absent', true from unnest($2::uuid[]) x
           on conflict (editor_id, date) do update set status = 'absent', auto_marked = true, updated_at = now()
           where attendance.check_in_at is null and attendance.status = 'no_sod' and attendance.marked_by is null`,
          [orgId, ids, today.ymd],
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
