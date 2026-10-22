import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { logActivity } from "../activity.js";
import { isSuperHere } from "../super-admin.js";
import { callerScope, clearSettingsCache, istNow, permissionsReady, readSettings } from "../attendance.js";
import { editorRanks, taskViewer } from "../hierarchy.js";
import { LEAVE_COLS, LeaveError, balances, cancelLeave, createLeave, decideLeave, isApprover, leaveReady, leaveRules, previewLeave } from "../leave.js";
import { n1, requestWords, validYmd } from "../leave-math.js";

// Leave — CL (casual) and SL (sick): ask, decide, cancel, balances, the
// starting allowance, top-ups and the rules. The Leave page (pages/leave.tsx)
// and the Home side panel use these; rules in leave.js / leave-math.js.
//   Anyone with a team-member login asks for their own leave (once a manager
//   has started counting). Managers (Manager, Asst. Manager) and admins decide —
//   never their own — set the starting allowance until counting starts, and top
//   up after. Only a Super Admin edits the starting allowance once counting has
//   started, or the rules.
export const leaveRouter = Router();

const NEEDS_DB = "Leave needs a database update first — ask whoever runs the database to apply 20261030120000_leave.";
// a real calendar day (not 2026-02-30, or a year far off)
const YMD = z.string().refine(validYmd);
const halves = (max) => z.number().min(0).max(max).refine((v) => Number.isInteger(v * 2), "Use whole or half days.");

async function ready(res) {
  if (await leaveReady()) return true;
  res.status(409).json({ error: NEEDS_DB });
  return false;
}
function fail(res, next, err) {
  if (err instanceof LeaveError) return res.status(err.status).json({ error: err.message });
  return next(err);
}
const yearOf = (q, today) => (/^\d{4}$/.test(String(q ?? "")) ? Number(q) : Number(today.slice(0, 4)));
async function names(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return new Map();
  const { rows } = await pool.query("select id, name, image_url as \"imageUrl\" from editor where id = any($1::uuid[])", [list]);
  return new Map(rows.map((r) => [r.id, r]));
}
async function userNames(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return new Map();
  const { rows } = await pool.query(
    "select u.id, coalesce(e.name, u.name, u.email) as name from app_user u left join editor e on e.id = u.editor_id where u.id = any($1::uuid[])",
    [list],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}
async function log(req, verb, editorId, summary, meta = {}) {
  await logActivity({ orgId: req.orgId, actorId: req.user.sub, verb, entityType: "editor", entityId: editorId, summary, meta });
}
// Everyone whose leave is counted: active team members with an active login.
async function leavePeople(orgId) {
  const { rows } = await pool.query(
    `select distinct e.id, e.name, e.designation, e.image_url as "imageUrl"
       from editor e join app_user u on u.editor_id = e.id and u.active
      where e.org_id = $1 and e.active order by e.name`,
    [orgId],
  );
  return rows;
}
const rulesOut = (r) => ({ noticeDays: r.noticeDays, shortNoticePts: r.shortNoticePts, unpaidPts: r.unpaidPts });

// GET /leave/mine?year= — your balance (per type: starting days, top-ups,
// total, taken, waiting, left) and your requests (that year's and anything
// still ahead).
leaveRouter.get("/leave/mine", async (req, res, next) => {
  try {
    if (!(await leaveReady())) return res.json({ ready: false });
    const today = istNow().ymd;
    const year = yearOf(req.query.year, today);
    const [caller, { att }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    const rules = leaveRules(att);
    const base = { ready: true, year, today, rules: rulesOut(rules), counting: !!rules.countingSince, countingSince: rules.countingSince, canApprove: isApprover(caller) };
    if (!caller.editorId) return res.json({ ...base, linked: false, balance: null, requests: [] });
    const [bal, { rows: requests }] = await Promise.all([
      balances([caller.editorId], year),
      pool.query(
        `select ${LEAVE_COLS} from leave_request
          where editor_id = $1 and (extract(year from date_from) = $2 or date_to >= $3::date)
          order by date_from desc limit 80`,
        [caller.editorId, year, today],
      ),
    ]);
    const by = await userNames(requests.map((r) => r.decidedBy));
    res.json({ ...base, linked: true, name: caller.name, balance: bal.get(caller.editorId), requests: requests.map((r) => ({ ...r, decidedByName: by.get(r.decidedBy) ?? null })) });
  } catch (err) { next(err); }
});

// POST /leave { type, from, to, half, reason } — ask for leave; it waits for a
// manager and holds its paid days meanwhile.
leaveRouter.post("/leave", async (req, res, next) => {
  const parsed = z.object({
    type: z.enum(["CL", "SL"]), from: YMD, to: YMD.optional(), half: z.enum(["full", "first", "second"]).optional(),
    reason: z.string().trim().max(300).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick CL or SL and the days." });
  try {
    if (!(await ready(res))) return;
    const [caller, { cal, att }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    if (!caller.editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const rules = leaveRules(att);
    if (!rules.countingSince) return res.status(409).json({ error: "Leave opens once a manager has set everyone's allowance and started counting." });
    const d = parsed.data;
    const made = await createLeave({
      orgId: req.orgId, editorId: caller.editorId, type: d.type, from: d.from, to: d.to ?? d.from, half: d.half ?? "full",
      reason: d.reason, askedBy: req.user.sub, cal, rules, today: istNow().ymd,
    });
    for (const r of made) {
      await log(req, "leave_asked", r.editorId,
        `${caller.name ?? "Someone"} asked for ${requestWords(r)}${r.short ? " · short notice" : ""}${r.unpaid ? ` · ${n1(r.unpaid)} unpaid` : ""}`,
        { leaveId: r.id, type: r.type, from: r.from, to: r.to });
    }
    res.status(201).json({ requests: made });
  } catch (err) { fail(res, next, err); }
});

// POST /leave/preview { type, from, to, half } — what that request would be
// (days, notice, paid / unpaid, points), for the form's summary. Nothing saved.
leaveRouter.post("/leave/preview", async (req, res, next) => {
  const parsed = z.object({ type: z.enum(["CL", "SL"]), from: YMD, to: YMD.optional(), half: z.enum(["full", "first", "second"]).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.json({ error: "Pick the days." });
  try {
    if (!(await ready(res))) return;
    const [caller, { cal, att }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    if (!caller.editorId) return res.json({ error: "Your account isn't linked to a team member." });
    const d = parsed.data;
    res.json(await previewLeave({
      editorId: caller.editorId, type: d.type, from: d.from, to: d.to ?? d.from, half: d.half ?? "full",
      cal, rules: leaveRules(att), today: istNow().ymd,
    }));
  } catch (err) { next(err); }
});

// POST /leave/:id/decide { approve } — a manager's answer (not on their own).
leaveRouter.post("/leave/:id/decide", async (req, res, next) => {
  const parsed = z.object({ approve: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Approve or decline." });
  try {
    if (!(await ready(res))) return;
    const [caller, { cal }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    if (!isApprover(caller)) return res.status(403).json({ error: "Only a manager can approve or decline leave." });
    const r = await decideLeave({
      orgId: req.orgId, id: req.params.id, approve: parsed.data.approve, deciderUserId: req.user.sub, deciderEditorId: caller.editorId,
      cal, today: istNow().ymd,
    });
    const who = (await names([r.editorId])).get(r.editorId)?.name ?? "Someone";
    await log(req, r.status === "approved" ? "leave_approved" : "leave_declined", r.editorId,
      `${r.status === "approved" ? "Approved" : "Declined"} ${who}'s ${requestWords(r)}${r.status === "approved" && r.pts ? ` · −${n1(r.pts)} pts` : ""}`,
      { leaveId: r.id });
    res.json({ request: r });
  } catch (err) { fail(res, next, err); }
});

// POST /leave/:id/cancel — the person (waiting, or approved and not started) or
// a manager (any not started). The balance goes back; no points are charged.
leaveRouter.post("/leave/:id/cancel", async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "Leave request not found." });
  try {
    if (!(await ready(res))) return;
    const [caller, { cal, att }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    const r = await cancelLeave({
      orgId: req.orgId, id: req.params.id, byEditorId: caller.editorId, manager: isApprover(caller), cal, att, today: istNow().ymd,
    });
    const own = r.editorId === caller.editorId;
    const who = own ? null : (await names([r.editorId])).get(r.editorId)?.name ?? "Someone";
    await log(req, "leave_cancelled", r.editorId, own ? `${caller.name ?? "Someone"} cancelled their ${requestWords(r)}` : `Cancelled ${who}'s ${requestWords(r)}`, { leaveId: r.id });
    res.json({ request: r });
  } catch (err) { fail(res, next, err); }
});

// GET /leave/team?year= — managers: requests waiting, recent answers, each
// person's balance and starting allowance, top-ups, the rules.
leaveRouter.get("/leave/team", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    const today = istNow().ymd;
    const year = yearOf(req.query.year, today);
    const [caller, { att }, people, superHere, viewer, ranks, permOn] = await Promise.all([
      callerScope(req), readSettings(req.orgId), leavePeople(req.orgId), isSuperHere(req), taskViewer(req), editorRanks(req.orgId), permissionsReady(),
    ]);
    if (!isApprover(caller)) return res.status(403).json({ error: "Only a manager can see the team's leave." });
    const rules = leaveRules(att);
    const [bal, pending, decided, grants, started] = await Promise.all([
      balances(people.map((p) => p.id), year),
      pool.query(`select ${LEAVE_COLS} from leave_request where org_id = $1 and status = 'pending' order by date_from`, [req.orgId]),
      pool.query(
        `select ${LEAVE_COLS} from leave_request where org_id = $1 and status <> 'pending' and extract(year from date_from) = $2
          order by coalesce(decided_at, created_at) desc limit 30`,
        [req.orgId, year],
      ),
      pool.query(
        `select id, editor_id as "editorId", type, days::float as days, note, granted_by as "grantedBy", created_at as "at"
           from leave_grant where org_id = $1 and year = $2 order by created_at desc`,
        [req.orgId, year],
      ),
      pool.query("select distinct editor_id from leave_allowance where org_id = $1", [req.orgId]),
    ]);
    const hasStart = new Set(started.rows.map((r) => r.editor_id));
    // permissions too: each person's count this month, and the requests waiting
    // from people below you (whoever sees all: everyone but you)
    const below = (id) => caller.scope !== "self" && id !== caller.editorId && (viewer.seesAll || (ranks.get(id) ?? 3) > viewer.rank);
    const [permUsed, permWaiting] = permOn
      ? await Promise.all([
        pool.query(
          `select editor_id, count(*)::int as n from attendance_permission
            where org_id = $1 and status <> 'declined' and date >= date_trunc('month', $2::date) and date < date_trunc('month', $2::date) + interval '1 month'
            group by editor_id`,
          [req.orgId, today],
        ),
        pool.query(
          `select id, editor_id as "editorId", date::text as date, part, note, created_at as "createdAt" from attendance_permission
            where org_id = $1 and status = 'requested' and date >= $2::date order by date, part`,
          [req.orgId, today],
        ),
      ])
      : [{ rows: [] }, { rows: [] }];
    const usedBy = new Map(permUsed.rows.map((r) => [r.editor_id, r.n]));
    const permPending = permWaiting.rows.filter((p) => below(p.editorId));
    const who = await names([...pending.rows, ...decided.rows, ...grants.rows, ...permPending].map((r) => r.editorId));
    const by = await userNames([...decided.rows.map((r) => r.decidedBy), ...grants.rows.map((g) => g.grantedBy)]);
    const named = (r) => ({ ...r, name: who.get(r.editorId)?.name ?? "Someone", imageUrl: who.get(r.editorId)?.imageUrl ?? null });
    res.json({
      year, today, rules: rulesOut(rules), counting: !!rules.countingSince, countingSince: rules.countingSince,
      me: caller.editorId, canEditRules: superHere, canEditStart: superHere || !rules.countingSince,
      people: people.map((p) => ({
        ...p, balance: bal.get(p.id), permissionsUsed: usedBy.get(p.id) ?? 0,
        // what you may change for them: never your own (another manager or the Super Admin does)
        canEditStart: superHere || (p.id !== caller.editorId && (!rules.countingSince || !hasStart.has(p.id))),
        canTopUp: !!rules.countingSince && (superHere || p.id !== caller.editorId),
      })),
      permissions: permOn ? { perMonth: att.permissionsPerMonth, pending: permPending.map(named) } : null,
      pending: pending.rows.map(named),
      decided: decided.rows.map((r) => ({ ...named(r), decidedByName: by.get(r.decidedBy) ?? null })),
      grants: grants.rows.map((g) => ({ ...named(g), byName: by.get(g.grantedBy) ?? null })),
    });
  } catch (err) { next(err); }
});

// PUT /leave/allowance/:editorId { year, cl, sl } — the starting allowance:
// managers until counting starts, then only a Super Admin.
leaveRouter.put("/leave/allowance/:editorId", async (req, res, next) => {
  const parsed = z.object({ year: z.number().int().min(2020).max(2100), cl: halves(60), sl: halves(60) }).safeParse(req.body ?? {});
  if (!parsed.success || !z.string().uuid().safeParse(req.params.editorId).success) return res.status(400).json({ error: "Days are 0 to 60, in whole or half days." });
  try {
    if (!(await ready(res))) return;
    const [caller, { att }, superHere] = await Promise.all([callerScope(req), readSettings(req.orgId), isSuperHere(req)]);
    if (!isApprover(caller)) return res.status(403).json({ error: "Only a manager can set the allowance." });
    if (req.params.editorId === caller.editorId && !superHere) {
      return res.status(403).json({ error: "Another manager or the Super Admin sets your own allowance." });
    }
    // once counting has started only a Super Admin edits it — except someone's
    // very first allowance (a new joiner)
    if (leaveRules(att).countingSince && !superHere) {
      const { rowCount: has } = await pool.query("select 1 from leave_allowance where editor_id = $1 limit 1", [req.params.editorId]);
      if (has) return res.status(403).json({ error: "Counting has started, so only a Super Admin edits the starting allowance. Use Top up to add days." });
    }
    const { rows } = await pool.query("select name from editor where id = $1 and org_id = $2", [req.params.editorId, req.orgId]);
    if (!rows.length) return res.status(404).json({ error: "Team member not found." });
    const { year, cl, sl } = parsed.data;
    await pool.query(
      `insert into leave_allowance (org_id, editor_id, year, cl, sl) values ($1, $2, $3, $4, $5)
       on conflict (editor_id, year) do update set cl = excluded.cl, sl = excluded.sl`,
      [req.orgId, req.params.editorId, year, cl, sl],
    );
    await log(req, "leave_allowance_set", req.params.editorId, `Set ${rows[0].name}'s starting leave for ${year}: ${n1(cl)} CL, ${n1(sl)} SL`, { year, cl, sl });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /leave/start-counting — the starting allowances are set: from now on
// days are only added with a top-up, and team members can ask for leave.
leaveRouter.post("/leave/start-counting", async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    const [caller, { att }] = await Promise.all([callerScope(req), readSettings(req.orgId)]);
    if (!isApprover(caller)) return res.status(403).json({ error: "Only a manager can start counting." });
    if (leaveRules(att).countingSince) return res.status(409).json({ error: "Counting has already started." });
    const today = istNow().ymd;
    await pool.query(
      `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attendance}',
         coalesce(settings->'attendance', '{}'::jsonb)
           || jsonb_build_object('leave', coalesce(settings->'attendance'->'leave', '{}'::jsonb) || jsonb_build_object('countingSince', $2::text)))
       where id = $1`,
      [req.orgId, today],
    );
    clearSettingsCache(req.orgId);
    await log(req, "leave_counting_started", caller.editorId, "Started counting leave: days are added with a top-up from now on", { since: today });
    res.json({ countingSince: today });
  } catch (err) { next(err); }
});

// POST /leave/grant { editorId, type, days, note } — a top-up: days added to
// someone's year, with the reason, on record. Managers, once counting started.
leaveRouter.post("/leave/grant", async (req, res, next) => {
  const parsed = z.object({
    editorId: z.string().uuid(), type: z.enum(["CL", "SL"]), days: halves(15).refine((v) => v > 0, "At least half a day."),
    note: z.string().trim().min(1).max(300), year: z.number().int().min(2020).max(2100).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pick CL or SL, the days (half-day steps) and the reason." });
  try {
    if (!(await ready(res))) return;
    const [caller, { att }, superHere] = await Promise.all([callerScope(req), readSettings(req.orgId), isSuperHere(req)]);
    if (!isApprover(caller)) return res.status(403).json({ error: "Only a manager can add leave." });
    if (parsed.data.editorId === caller.editorId && !superHere) {
      return res.status(403).json({ error: "Another manager or the Super Admin adds days to your own leave." });
    }
    if (!leaveRules(att).countingSince) return res.status(409).json({ error: "Set the starting allowance and start counting first." });
    const { editorId, type, days, note } = parsed.data;
    const year = parsed.data.year ?? Number(istNow().ymd.slice(0, 4));
    const { rows } = await pool.query("select name from editor where id = $1 and org_id = $2", [editorId, req.orgId]);
    if (!rows.length) return res.status(404).json({ error: "Team member not found." });
    await pool.query(
      "insert into leave_grant (org_id, editor_id, year, type, days, note, granted_by) values ($1, $2, $3, $4, $5, $6, $7)",
      [req.orgId, editorId, year, type, days, note, req.user.sub],
    );
    await log(req, "leave_topped_up", editorId, `${caller.name ?? "A manager"} added ${n1(days)} ${type} for ${rows[0].name}: ${note}`, { year, type, days });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /leave/permissions { perMonth } — permissions a month, for everyone. An
// admin (like the other attendance rules); only this one setting is written.
leaveRouter.put("/leave/permissions", async (req, res, next) => {
  const parsed = z.object({ perMonth: z.number().int().min(0).max(10) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Permissions a month are 0 to 10." });
  try {
    if (req.role !== "admin") return res.status(403).json({ error: "Only an admin changes the permissions a month." });
    const { perMonth } = parsed.data;
    await pool.query(
      `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attendance}',
         coalesce(settings->'attendance', '{}'::jsonb) || jsonb_build_object('permissionsPerMonth', $2::int))
       where id = $1`,
      [req.orgId, perMonth],
    );
    clearSettingsCache(req.orgId);
    const caller = await callerScope(req);
    await log(req, "attendance_permissions_changed", caller.editorId, `Permissions a month: ${perMonth}`, { perMonth });
    res.json({ perMonth });
  } catch (err) { next(err); }
});

// PUT /leave/rules { noticeDays, shortNoticePts, unpaidPts } — a Super Admin.
// Requests already sent keep the points they were priced at; each change is
// kept in a log (like the attendance penalties').
leaveRouter.put("/leave/rules", async (req, res, next) => {
  const parsed = z.object({ noticeDays: z.number().int().min(0).max(10), shortNoticePts: halves(10), unpaidPts: halves(10) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Notice is 0 to 10 working days; points 0 to 10 in half steps." });
  try {
    if (!(await ready(res))) return;
    if (!(await isSuperHere(req))) return res.status(403).json({ error: "Only a Super Admin changes the leave rules." });
    const d = parsed.data;
    await pool.query(
      `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attendance}',
         coalesce(settings->'attendance', '{}'::jsonb)
           || jsonb_build_object('leave', coalesce(settings->'attendance'->'leave', '{}'::jsonb) || $2::jsonb)
           || jsonb_build_object('leaveLog', coalesce(settings->'attendance'->'leaveLog', '[]'::jsonb) || $3::jsonb))
       where id = $1`,
      [req.orgId, JSON.stringify(d), JSON.stringify([{ at: new Date().toISOString(), by: req.user.sub, ...d }])],
    );
    clearSettingsCache(req.orgId);
    const caller = await callerScope(req);
    await log(req, "leave_rules_changed", caller.editorId,
      `Leave rules: CL notice ${d.noticeDays} working days, short notice −${n1(d.shortNoticePts)} pts, unpaid −${n1(d.unpaidPts)} pts a day`, d);
    res.json({ rules: d });
  } catch (err) { next(err); }
});
