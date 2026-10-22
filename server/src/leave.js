import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { classify, openingFor } from "./attendance.js";

// Leave — CL (casual leave) and SL (sick leave). See migration
// 20261030120000_leave.sql.
//   CL: each person's own number a calendar year (editor.cl_per_year; none
//       set counts as 0), nothing carried over. Applied for less than the
//       notice days ahead (Settings › Attendance, 2 by default), each day is
//       short notice and costs the absence penalty (attendance.penaltyOf).
//       Past the year's CL the days are unpaid, the latest ones first.
//   SL: any time, no limit, only recorded.
// A person applies and a lead approves, or a lead marks it directly; approved
// days become attendance rows (leave, or half_day for a half day).
export const leaveReady = () => hasColumn("attendance", "short_notice");

const DAY_MS = 86_400_000;
const ymdAt = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (ymd, n) => ymdAt(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// The working days from..to (both included).
export function workingDays(cal, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (openingFor(cal, d)) out.push(d);
  return out;
}

// CL told less than the notice days ahead of its first day.
export const isShortNotice = (kind, firstDay, today, noticeDays) => kind === "cl" && daysBetween(today, firstDay) < noticeDays;

const LEAVE_COLS = `id, editor_id as "editorId", kind, dates::text[] as dates, half, short_notice as "shortNotice", status, note,
  decided_at as "decidedAt", created_at as "createdAt"`;

export async function leaveById(id) {
  const { rows } = await pool.query(`select ${LEAVE_COLS}, org_id as "orgId" from leave_request where id = $1`, [id]);
  return rows[0] ?? null;
}

// Someone's leave around now: waiting, and approved from a week ago on.
export async function leaveOf(editorId, today) {
  if (!(await leaveReady())) return [];
  const { rows } = await pool.query(
    `select ${LEAVE_COLS} from leave_request
      where editor_id = $1 and status in ('requested', 'approved') and dates[array_upper(dates, 1)] >= $2::date
      order by dates[1]`,
    [editorId, addDays(today, -7)],
  );
  return rows;
}

// Requests waiting for a lead, for these people.
export async function waitingLeave(editorIds) {
  if (!editorIds.length || !(await leaveReady())) return [];
  const { rows } = await pool.query(
    `select ${LEAVE_COLS} from leave_request where editor_id = any($1::uuid[]) and status = 'requested' order by dates[1]`,
    [editorIds],
  );
  return rows;
}

// Leave already booked (waiting or approved) on any of these days.
export async function clashingLeave(editorId, dates, exceptId = null) {
  const { rows } = await pool.query(
    `select d::text as date from leave_request, unnest(dates) d
      where editor_id = $1 and status in ('requested', 'approved') and d = any($2::date[]) and ($3::uuid is null or id <> $3)
      order by d limit 1`,
    [editorId, dates, exceptId],
  );
  return rows[0]?.date ?? null;
}

// A year's leave per person: the CL they have (perYear, null when none was
// set), CL taken (paid), unpaid days (CL past the year's number) and which,
// SL taken, and what's still waiting for a lead. Approved days count as taken
// whether they're past or ahead; the earliest CL days use the number first.
export async function leaveYear(editorIds, year) {
  const ids = [...new Set(editorIds)].filter(Boolean);
  const out = new Map(ids.map((id) => [id, { perYear: null, cl: 0, unpaid: 0, unpaidDates: [], sl: 0, waitingCl: 0, waitingSl: 0 }]));
  if (!ids.length || !(await leaveReady())) return out;
  const [{ rows: eds }, { rows: days }] = await Promise.all([
    pool.query("select id, cl_per_year from editor where id = any($1::uuid[])", [ids]),
    pool.query(
      `select editor_id, kind, half, status, d::text as date from leave_request, unnest(dates) d
        where editor_id = any($1::uuid[]) and status in ('requested', 'approved') and d between $2::date and $3::date
        order by d`,
      [ids, `${year}-01-01`, `${year}-12-31`],
    ),
  ]);
  for (const e of eds) out.get(e.id).perYear = e.cl_per_year == null ? null : Number(e.cl_per_year);
  for (const r of days) {
    const o = out.get(r.editor_id);
    const n = r.half ? 0.5 : 1;
    if (r.status === "requested") { if (r.kind === "cl") o.waitingCl += n; else o.waitingSl += n; continue; }
    if (r.kind === "sl") { o.sl += n; continue; }
    const paid = Math.min(n, Math.max(0, (o.perYear ?? 0) - o.cl));
    o.cl += paid;
    if (paid < n) { o.unpaid += n - paid; o.unpaidDates.push(r.date); }
  }
  return out;
}

// An approved leave's days become attendance rows. A whole day someone worked
// (checked in) is left as it was.
export async function writeLeaveDays(orgId, leave, actorId) {
  const status = leave.half ? "half_day" : "leave";
  const reason = `${leave.kind === "cl" ? "CL" : "SL"}${leave.note ? `: ${leave.note}` : ""}`.slice(0, 300);
  const written = [];
  for (const d of leave.dates) {
    const { rows } = await pool.query(
      `insert into attendance (org_id, editor_id, date, status, marked_by, reason, auto_marked, leave_id, leave_kind, short_notice)
       values ($1, $2, $3, $4, $5, $6, false, $7, $8, $9)
       on conflict (editor_id, date) do update set status = excluded.status, marked_by = excluded.marked_by, reason = excluded.reason,
         auto_marked = false, excused = false, leave_id = excluded.leave_id, leave_kind = excluded.leave_kind,
         short_notice = excluded.short_notice, updated_at = now()
       where attendance.check_in_at is null or excluded.status = 'half_day'
       returning date::text as date`,
      [orgId, leave.editorId, d, status, actorId, reason, leave.id, leave.kind, leave.shortNotice],
    );
    if (rows[0]) written.push(rows[0].date);
  }
  return written;
}

// Leave taken off (cancelled, or one day of it): its days go back to what the
// rules say — a day someone checked in is classified again from the check-in;
// otherwise the row goes (a past day is filled in again by the usual rules).
export async function clearLeaveDays(leaveId, cal, att, dates = null) {
  const { rows } = await pool.query(
    `select id, date::text as date, check_in_at from attendance where leave_id = $1${dates ? " and date = any($2::date[])" : ""}`,
    dates ? [leaveId, dates] : [leaveId],
  );
  for (const r of rows) {
    if (r.check_in_at) {
      const c = classify(r.check_in_at, r.date, cal, att);
      await pool.query(
        `update attendance set status = $2, late_minutes = $3, excused = false, marked_by = null, reason = null,
           leave_id = null, leave_kind = null, short_notice = false, updated_at = now() where id = $1`,
        [r.id, c.status, c.lateMinutes],
      );
    } else {
      await pool.query("delete from attendance where id = $1", [r.id]);
    }
  }
}

// One day taken off a leave (a lead's undo): the leave keeps its other days,
// or is cancelled when none are left.
export async function dropLeaveDay(leaveId, ymd) {
  await pool.query(
    `update leave_request set dates = array_remove(dates, $2::date),
       status = case when cardinality(array_remove(dates, $2::date)) = 0 then 'cancelled' else status end
     where id = $1`,
    [leaveId, ymd],
  );
}

// "24 Oct" or "24–26 Oct (3 days)", and "half day".
export function leaveWords(leave) {
  const f = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const n = leave.dates.length;
  const span = n === 1 ? f(leave.dates[0]) : `${f(leave.dates[0])} – ${f(leave.dates[n - 1])} (${n} days)`;
  return `${leave.kind === "cl" ? "CL" : "SL"} on ${span}${leave.half ? ", half day" : ""}`;
}
