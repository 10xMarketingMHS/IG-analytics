import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { classify, openingFor } from "./attendance.js";
import {
  LEAVE_DEFAULTS, checkRequest, dayWords, daysOf, priceRequest, rangeFrozen, requestWords, resplit, splitByYear, workingDates,
} from "./leave-math.js";

// Leave — CL (casual) and SL (sick): the database side. The maths is in
// leave-math.js; the routes in routes/leave.js. Migration 20261030120000_leave.
//   Balance for a type and year = starting allowance + top-ups; a request holds
//   its paid days while it waits and keeps them once approved. Every change to a
//   person's balance runs in one transaction with their allowance row locked
//   (select … for update), so two requests can't both take the last day.
//   Approved days are attendance rows: status leave (half_day for a half),
//   marked_by the manager, reason CL / SL / unpaid, leave_request_id.

export const leaveReady = () => hasColumn("leave_request", "paid_days");
export const isWorkingOn = (cal) => (ymd) => !!openingFor(cal, ymd);
export const leaveRules = (att) => ({ ...LEAVE_DEFAULTS, ...(att?.leave ?? {}) });
// Who decides leave: a Manager or Asst. Manager (Home role manager), or an
// admin — never on their own request (checked where it's decided).
export const isApprover = (caller) => caller.role === "manager" || !!caller.admin;

export class LeaveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const REQ_COLS = `id, org_id as "orgId", editor_id as "editorId", type, date_from::text as "from", date_to::text as "to", half,
  days::float as days, paid_days::float as paid, unpaid_days::float as unpaid, notice_days as notice, short_notice as short,
  penalty_pts::float as pts, short_pts::float as "shortPts", unpaid_rate::float as "unpaidRate", status, reason,
  asked_by as "askedBy", decided_by as "decidedBy", decided_at as "decidedAt", created_at as "createdAt"`;
export const LEAVE_COLS = REQ_COLS;

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The person's allowance row for a year, made if missing, and locked until the
// transaction ends.
async function lockYear(client, orgId, editorId, year) {
  await client.query("insert into leave_allowance (org_id, editor_id, year) values ($1, $2, $3) on conflict do nothing", [orgId, editorId, year]);
  await client.query("select 1 from leave_allowance where editor_id = $1 and year = $2 for update", [editorId, year]);
}

// Starting allowance and top-ups, per person and type, for a year.
async function totalsFor(q, editorIds, year) {
  const [{ rows: al }, { rows: gr }] = await Promise.all([
    q.query("select editor_id, cl::float as cl, sl::float as sl from leave_allowance where editor_id = any($1::uuid[]) and year = $2", [editorIds, year]),
    q.query("select editor_id, type, sum(days)::float as days from leave_grant where editor_id = any($1::uuid[]) and year = $2 group by 1, 2", [editorIds, year]),
  ]);
  const out = new Map(editorIds.map((id) => [id, { CL: { start: 0, topups: 0, total: 0 }, SL: { start: 0, topups: 0, total: 0 } }]));
  for (const a of al) { const o = out.get(a.editor_id); o.CL.start = a.cl; o.SL.start = a.sl; }
  for (const g of gr) out.get(g.editor_id)[g.type].topups = g.days;
  for (const o of out.values()) for (const t of ["CL", "SL"]) o[t].total = o[t].start + o[t].topups;
  return out;
}
async function totalOf(q, editorId, year, type) {
  return (await totalsFor(q, [editorId], year)).get(editorId)[type].total;
}
// Paid days held by waiting and approved requests of a type that start in a year.
async function usedPaid(q, editorId, year, type, exceptId = null) {
  const { rows } = await q.query(
    `select coalesce(sum(paid_days), 0)::float as n from leave_request
      where editor_id = $1 and type = $2 and status in ('pending', 'approved') and extract(year from date_from) = $3
        and ($4::uuid is null or id <> $4)`,
    [editorId, type, year, exceptId],
  );
  return rows[0].n;
}

// Each person's year: per type the starting days, top-ups, total, taken
// (approved), waiting and left; unpaid days (approved and waiting) and points
// cut (approved).
export async function balances(editorIds, year) {
  const ids = [...new Set(editorIds)].filter(Boolean);
  const out = new Map();
  if (!ids.length || !(await leaveReady())) return out;
  const [tot, { rows }] = await Promise.all([
    totalsFor(pool, ids, year),
    pool.query(
      `select editor_id, type, status, sum(paid_days)::float as paid, sum(unpaid_days)::float as unpaid, sum(penalty_pts)::float as pts
         from leave_request
        where editor_id = any($1::uuid[]) and status in ('pending', 'approved') and extract(year from date_from) = $2
        group by 1, 2, 3`,
      [ids, year],
    ),
  ]);
  for (const id of ids) {
    const t = tot.get(id);
    out.set(id, {
      CL: { ...t.CL, taken: 0, waiting: 0, left: 0 }, SL: { ...t.SL, taken: 0, waiting: 0, left: 0 },
      unpaid: 0, unpaidWaiting: 0, pts: 0,
    });
  }
  for (const r of rows) {
    const o = out.get(r.editor_id);
    if (r.status === "approved") { o[r.type].taken += r.paid; o.unpaid += r.unpaid; o.pts += r.pts; }
    else { o[r.type].waiting += r.paid; o.unpaidWaiting += r.unpaid; }
  }
  for (const o of out.values()) for (const t of ["CL", "SL"]) o[t].left = Math.max(0, o[t].total - o[t].taken - o[t].waiting);
  return out;
}

// A whole day someone checked in on can't be leave.
async function workedOn(q, editorId, dates) {
  if (!dates.length) return null;
  const { rows } = await q.query(
    "select date::text as date from attendance where editor_id = $1 and date = any($2::date[]) and check_in_at is not null order by date limit 1",
    [editorId, dates],
  );
  return rows[0]?.date ?? null;
}

// Approved days into attendance, labelled CL / SL while paid days last and
// unpaid after (a whole day already worked is left alone).
async function writeDays(client, orgId, r, deciderId, isWorking) {
  const half = r.half !== "full";
  const dates = half ? [r.from] : workingDates(isWorking, r.from, r.to);
  let paid = r.paid;
  for (const d of dates) {
    const size = half ? 0.5 : 1;
    const reason = paid > 0 ? r.type : "unpaid";
    paid -= Math.min(size, paid);
    await client.query(
      `insert into attendance (org_id, editor_id, date, status, marked_by, reason, auto_marked, leave_request_id)
       values ($1, $2, $3, $4, $5, $6, false, $7)
       on conflict (editor_id, date) do update set status = excluded.status, marked_by = excluded.marked_by, reason = excluded.reason,
         auto_marked = false, excused = false, leave_request_id = excluded.leave_request_id, updated_at = now()
       where attendance.check_in_at is null or excluded.status = 'half_day'`,
      [orgId, r.editorId, d, half ? "half_day" : "leave", deciderId, reason, r.id],
    );
  }
}
// After a re-split, the leave days still on leave say CL / SL or unpaid again,
// in date order.
async function relabel(client, r) {
  const { rows } = await client.query(
    "select id, status from attendance where leave_request_id = $1 and status in ('leave', 'half_day') order by date",
    [r.id],
  );
  let paid = r.paid;
  for (const row of rows) {
    const size = row.status === "half_day" ? 0.5 : 1;
    const reason = paid > 0 ? r.type : "unpaid";
    paid -= Math.min(size, paid);
    await client.query("update attendance set reason = $2 where id = $1 and reason is distinct from $2", [row.id, reason]);
  }
}

async function getRequest(q, id, lock = false) {
  const { rows } = await q.query(`select ${REQ_COLS} from leave_request where id = $1${lock ? " for update" : ""}`, [id]);
  return rows[0] ?? null;
}
export const leaveById = (id) => getRequest(pool, id);

// A request (waiting for a manager), or a manager's own mark (approved and
// written to attendance at once — a manager's mark is the asking, so its notice
// counts from today). A range over 31 Dec becomes one request per year.
export async function createLeave({ orgId, editorId, type, from, to, half = "full", reason = null, askedBy, approvedBy = null, cal, rules, today }) {
  const isWorking = isWorkingOn(cal);
  // a manager may also put right a past day (CL or SL), from last month on
  const bad = checkRequest({ type, from, to, half, today, isWorking: isWorking });
  if (bad && !(approvedBy && /past day|go back 7 days/.test(bad))) throw new LeaveError(400, bad);
  return tx(async (client) => {
    const parts = splitByYear(from, to);
    for (const [a] of parts) await lockYear(client, orgId, editorId, Number(a.slice(0, 4)));
    const { rows: clash } = await client.query(
      `select type, date_from::text as "from" from leave_request
        where editor_id = $1 and status in ('pending', 'approved') and date_from <= $3 and date_to >= $2 order by date_from limit 1`,
      [editorId, from, to],
    );
    if (clash[0]) throw new LeaveError(409, `It overlaps the ${clash[0].type} on ${dayWords(clash[0].from)}.`);
    if (half === "full") {
      const worked = await workedOn(client, editorId, workingDates(isWorking, from, to));
      if (worked) throw new LeaveError(409, `There's a check-in on ${dayWords(worked)}, so it can't be a full day of leave. A half day can.`);
    }
    const made = [];
    for (const [i, [a, b]] of parts.entries()) {
      const year = Number(a.slice(0, 4));
      const days = daysOf(isWorking, a, b, half);
      if (!days) continue;
      const p = priceRequest({
        type, days, from, today, isWorking, rules, shortApplies: i === 0,
        total: await totalOf(client, editorId, year, type), used: await usedPaid(client, editorId, year, type),
      });
      const { rows } = await client.query(
        `insert into leave_request (org_id, editor_id, type, date_from, date_to, half, days, paid_days, unpaid_days, notice_days,
           short_notice, penalty_pts, short_pts, unpaid_rate, status, reason, asked_by, decided_by, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
        [orgId, editorId, type, a, b, half, p.days, p.paid, p.unpaid, p.notice, p.short, p.pts, p.shortPts, p.unpaidRate,
          approvedBy ? "approved" : "pending", reason || null, askedBy, approvedBy, approvedBy ? new Date() : null],
      );
      const r = await getRequest(client, rows[0].id);
      if (approvedBy) await writeDays(client, orgId, r, approvedBy, isWorking);
      made.push(r);
    }
    return made;
  });
}

const frozenMsg = (ym) => {
  const d = new Date(`${ym}-01T00:00:00Z`);
  return `${d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })} is closed in Management Performance, so its leave can't change.`;
};

// A manager's answer. Approving re-checks the balance (another request may
// have used it, or given some back) and re-splits paid and unpaid at the same
// rates; two managers answering at once: the request row is locked, so only
// the first one counts.
export async function decideLeave({ orgId, id, approve, deciderUserId, deciderEditorId, cal, today }) {
  const isWorking = isWorkingOn(cal);
  return tx(async (client) => {
    const r = await getRequest(client, id, true);
    if (!r || r.orgId !== orgId) throw new LeaveError(404, "Leave request not found.");
    if (deciderEditorId && r.editorId === deciderEditorId) throw new LeaveError(403, "You can't decide your own leave. Another manager does.");
    if (r.status !== "pending") throw new LeaveError(409, `It's already ${r.status === "approved" ? "approved" : r.status}.`);
    const frozen = rangeFrozen(r.from, r.to, today);
    if (frozen) throw new LeaveError(409, frozenMsg(frozen));
    if (!approve) {
      await client.query("update leave_request set status = 'declined', decided_by = $2, decided_at = now() where id = $1", [id, deciderUserId]);
      return { ...r, status: "declined" };
    }
    const year = Number(r.from.slice(0, 4));
    await lockYear(client, orgId, r.editorId, year);
    if (r.half === "full") {
      const worked = await workedOn(client, r.editorId, workingDates(isWorking, r.from, r.to));
      if (worked) throw new LeaveError(409, `They checked in on ${dayWords(worked)} since asking. Decline it, and they can ask again for the right days.`);
    }
    const s = resplit({
      days: r.days, shortPts: r.shortPts, unpaidRate: r.unpaidRate,
      total: await totalOf(client, r.editorId, year, r.type), usedByOthers: await usedPaid(client, r.editorId, year, r.type, id),
    });
    await client.query(
      `update leave_request set status = 'approved', paid_days = $2, unpaid_days = $3, penalty_pts = $4, decided_by = $5, decided_at = now()
        where id = $1`,
      [id, s.paid, s.unpaid, s.pts, deciderUserId],
    );
    const out = { ...r, status: "approved", paid: s.paid, unpaid: s.unpaid, pts: s.pts };
    await writeDays(client, orgId, out, deciderUserId, isWorking);
    return out;
  });
}

// Take a request back: its owner while it waits or before an approved one
// starts; a manager any that hasn't started. The days it put in attendance go
// (a half day with a check-in is classified from the check-in instead).
export async function cancelLeave({ orgId, id, byEditorId, manager, cal, att, today }) {
  return tx(async (client) => {
    const r = await getRequest(client, id, true);
    if (!r || r.orgId !== orgId) throw new LeaveError(404, "Leave request not found.");
    const own = !!byEditorId && r.editorId === byEditorId;
    if (!own && !manager) throw new LeaveError(403, "Only the person or a manager can cancel it.");
    if (r.status !== "pending" && r.status !== "approved") throw new LeaveError(409, "That leave is already closed.");
    const started = r.from <= today;
    if (started && (r.status === "approved" || !own)) {
      throw new LeaveError(409, own ? "It has started — ask a manager to change it." : r.status === "pending" ? "It has started — decline it instead." : "It has started, so it can't be cancelled.");
    }
    const frozen = rangeFrozen(r.from, r.to, today);
    if (frozen) throw new LeaveError(409, frozenMsg(frozen));
    await client.query("update leave_request set status = 'cancelled' where id = $1", [id]);
    if (r.status === "approved") await clearDays(client, id, cal, att);
    return { ...r, status: "cancelled" };
  });
}
async function clearDays(client, id, cal, att) {
  const { rows } = await client.query(
    "select id, date::text as date, check_in_at from attendance where leave_request_id = $1 and status in ('leave', 'half_day')",
    [id],
  );
  for (const row of rows) {
    if (row.check_in_at) {
      const c = classify(row.check_in_at, row.date, cal, att);
      await client.query(
        `update attendance set status = $2, late_minutes = $3, excused = false, marked_by = null, reason = null, leave_request_id = null,
           updated_at = now() where id = $1`,
        [row.id, c.status, c.lateMinutes],
      );
    } else {
      await client.query("delete from attendance where id = $1", [row.id]);
    }
  }
}

// One day changed on an approved leave: worked after all (Start day on it), put
// back (Undo Start day), or taken off by a manager. The leave grows or shrinks
// by the day and is re-split against the balance (unpaid days go first when it
// shrinks), so the day goes back to — or comes from — the person's balance.
async function changeDays(client, r, delta) {
  const year = Number(r.from.slice(0, 4));
  await lockYear(client, r.orgId, r.editorId, year);
  const days = Math.max(0, r.days + delta);
  const s = resplit({
    days, shortPts: r.shortPts, unpaidRate: r.unpaidRate,
    total: await totalOf(client, r.editorId, year, r.type), usedByOthers: await usedPaid(client, r.editorId, year, r.type, r.id),
  });
  await client.query(
    "update leave_request set days = $2, paid_days = $3, unpaid_days = $4, penalty_pts = $5 where id = $1",
    [r.id, days, s.paid, s.unpaid, s.pts],
  );
  const out = { ...r, days, paid: s.paid, unpaid: s.unpaid, pts: s.pts };
  await relabel(client, out);
  return out;
}

// Start day on a whole day of approved leave: the day turns back into a working
// day and goes back to the balance. The row keeps leave_request_id (the
// check-in sets its status), so Undo Start day can put the leave back.
export async function workedLeaveDay(row) {
  if (!row?.leaveRequestId || row.status !== "leave" || !(await leaveReady())) return null;
  return tx(async (client) => {
    const r = await getRequest(client, row.leaveRequestId, true);
    if (!r || r.status !== "approved") return null;
    const out = await changeDays(client, r, -1);
    // a working day now (Start day classified it): no leave words on it
    await client.query("update attendance set reason = null, marked_by = null where id = $1 and status not in ('leave', 'half_day')", [row.id]);
    return out;
  });
}

// Undo Start day on a day that was approved leave: the leave comes back — the
// row is a leave day again (marked by whoever approved it) and the day comes
// from the balance again.
export async function restoreLeaveDay(row) {
  if (!row?.leaveRequestId || row.status === "leave" || row.status === "half_day" || !(await leaveReady())) return null;
  return tx(async (client) => {
    const r = await getRequest(client, row.leaveRequestId, true);
    if (!r || r.status !== "approved" || row.date < r.from || row.date > r.to) return null;
    const out = await changeDays(client, r, 1);
    await client.query(
      `update attendance set status = 'leave', marked_by = $2, check_in_at = null, late_minutes = 0, excused = false, auto_marked = false,
         reason = $3, updated_at = now() where id = $1`,
      [row.id, r.decidedBy, r.type],
    );
    await relabel(client, out);
    return out;
  });
}

// A manager takes one day off an approved leave (Team › Attendance, or Undo on
// Team today): the leave keeps its other days, or is cancelled when none are
// left. The caller then sets the row right.
export async function dropLeaveDay(row, today) {
  if (!row?.leaveRequestId || !(await leaveReady())) return null;
  const frozen = rangeFrozen(row.date, row.date, today);
  if (frozen) throw new LeaveError(409, frozenMsg(frozen));
  return tx(async (client) => {
    const r = await getRequest(client, row.leaveRequestId, true);
    await client.query("update attendance set leave_request_id = null where id = $1", [row.id]);
    if (!r || r.status !== "approved") return null;
    const out = await changeDays(client, r, row.status === "half_day" ? -0.5 : -1);
    if (out.days <= 0) await client.query("update leave_request set status = 'cancelled' where id = $1", [r.id]);
    return out;
  });
}

export { requestWords };
