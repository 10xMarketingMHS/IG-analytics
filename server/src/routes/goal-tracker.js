import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

// Goals — admin-only manual goal-tracking dashboard. Every value here is entered
// by an admin; nothing wires to Task Points or Goal Setting. Distinct from
// goalsRouter (/goals = Goal Setting) — this lives under /goal-tracker. Admin
// only, end to end (requireAdmin on every route, no grant exceptions).
export const goalTrackerRouter = Router();

const GOAL_TYPES = ["revenue", "overall_team", "project_work", "custom"];

// Column list for a goal row, parametrised by table prefix so the SELECTs
// (aliased `g.`, joined to workspace) and INSERT/UPDATE ... RETURNING (no alias)
// share one definition. numeric → ::float so JSON gets numbers, not strings;
// date → ::text so it's a plain YYYY-MM-DD, not a timezone-shifted timestamp.
const goalCols = (p) =>
  `${p}id, ${p}created_by as "createdBy", ${p}owner_id as "ownerId", ${p}type, ${p}title, ${p}description,
   ${p}unit_label as "unitLabel", ${p}target_value::float as "targetValue",
   ${p}current_value::float as "currentValue", ${p}channel_id as "channelId",
   ${p}deadline::text as deadline, ${p}created_at as "createdAt"`;

const goalCreate = z.object({
  type: z.enum(GOAL_TYPES),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  unitLabel: z.string().trim().max(40).optional().nullable(),
  targetValue: z.number().finite(),
  initialValue: z.number().finite().optional(),
  channelId: z.string().uuid().optional().nullable(),
  ownerId: z.string().uuid().optional().nullable(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});
const goalPatch = z.object({
  type: z.enum(GOAL_TYPES).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  unitLabel: z.string().trim().max(40).optional().nullable(),
  targetValue: z.number().finite().optional(),
  channelId: z.string().uuid().optional().nullable(),
  ownerId: z.string().uuid().optional().nullable(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});
const progressCreate = z.object({
  value: z.number().finite(),
  note: z.string().trim().max(1000).optional().nullable(),
});

async function assertChannelInOrg(runner, channelId, orgId) {
  if (!channelId) return true;
  const { rowCount } = await runner.query("select 1 from workspace where id = $1 and org_id = $2", [channelId, orgId]);
  return rowCount > 0;
}

// A goal owner must be an admin somewhere in the org.
async function isOrgAdmin(runner, userId, orgId) {
  const { rowCount } = await runner.query(
    `select 1 from membership m join workspace w on w.id = m.workspace_id
      where m.user_id = $1 and w.org_id = $2 and m.role = 'admin' limit 1`,
    [userId, orgId],
  );
  return rowCount > 0;
}

// List every goal in the org, with channel, owner name, and update count.
goalTrackerRouter.get("/goal-tracker", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${goalCols("g.")}, w.name as "channelName", own.name as "ownerName",
              (select count(*) from goal_progress_update u where u.goal_id = g.id)::int as "updateCount"
         from goal g
         left join workspace w on w.id = g.channel_id
         left join app_user own on own.id = g.owner_id
        where g.org_id = $1
        order by g.created_at desc`,
      [req.orgId],
    );
    res.json({ goals: rows });
  } catch (err) { next(err); }
});

// The org's admins — for the "Goal For" picker and the per-admin view. Declared
// before /goal-tracker/:id so "admins" isn't captured as an :id.
goalTrackerRouter.get("/goal-tracker/admins", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select distinct u.id, u.name, u.email
         from app_user u
         join membership m on m.user_id = u.id
         join workspace w on w.id = m.workspace_id
        where w.org_id = $1 and m.role = 'admin'
        order by u.name`,
      [req.orgId],
    );
    res.json({ admins: rows });
  } catch (err) { next(err); }
});

// Create a goal. An initial progress row (the starting value) is inserted in the
// same transaction so current_value always mirrors the history and the chart has
// a baseline point.
goalTrackerRouter.post("/goal-tracker", requireAdmin, async (req, res, next) => {
  const parsed = goalCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Fill in a title, a type, and a numeric target." });
  const b = parsed.data;
  const initial = b.initialValue ?? 0;
  const owner = b.ownerId || req.user.sub; // "Goal For" — defaults to the creator
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await assertChannelInOrg(client, b.channelId, req.orgId))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Unknown channel." });
    }
    if (!(await isOrgAdmin(client, owner, req.orgId))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "A goal can only be assigned to an admin." });
    }
    const { rows } = await client.query(
      `insert into goal (org_id, created_by, owner_id, type, title, description, unit_label, target_value, current_value, channel_id, deadline)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning ${goalCols("")}`,
      [req.orgId, req.user.sub, owner, b.type, b.title, b.description || null, b.unitLabel || null,
       b.targetValue, initial, b.channelId || null, b.deadline || null],
    );
    await client.query(
      "insert into goal_progress_update (goal_id, value, note, updated_by) values ($1,$2,$3,$4)",
      [rows[0].id, initial, "Starting value", req.user.sub],
    );
    await client.query("COMMIT");
    res.status(201).json({ goal: rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// One goal + its full progress history (chronological — feeds the chart).
goalTrackerRouter.get("/goal-tracker/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${goalCols("g.")}, w.name as "channelName", own.name as "ownerName"
         from goal g
         left join workspace w on w.id = g.channel_id
         left join app_user own on own.id = g.owner_id
        where g.id = $1 and g.org_id = $2`,
      [req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: "Goal not found." });
    const { rows: updates } = await pool.query(
      `select u.id, u.value::float as value, u.note, u.updated_at as "updatedAt", au.name as "byName"
         from goal_progress_update u
         left join app_user au on au.id = u.updated_by
        where u.goal_id = $1
        order by u.updated_at asc`,
      [req.params.id],
    );
    res.json({ goal: rows[0], updates });
  } catch (err) { next(err); }
});

// Record a progress update: append a history row AND sync goal.current_value in
// one transaction, so the cached value can never drift from the latest row.
goalTrackerRouter.post("/goal-tracker/:id/progress", requireAdmin, async (req, res, next) => {
  const parsed = progressCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a numeric value." });
  const { value, note } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: g } = await client.query(
      "select id from goal where id = $1 and org_id = $2 for update", [req.params.id, req.orgId],
    );
    if (!g.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Goal not found." }); }
    const { rows: upd } = await client.query(
      `insert into goal_progress_update (goal_id, value, note, updated_by) values ($1,$2,$3,$4)
       returning id, value::float as value, note, updated_at as "updatedAt"`,
      [req.params.id, value, note || null, req.user.sub],
    );
    await client.query("update goal set current_value = $1 where id = $2", [value, req.params.id]);
    await client.query("COMMIT");
    res.status(201).json({ update: upd[0], currentValue: value });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Edit a goal's meta. current_value is intentionally NOT editable here — it only
// ever moves through a progress update.
goalTrackerRouter.patch("/goal-tracker/:id", requireAdmin, async (req, res, next) => {
  const parsed = goalPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid goal fields." });
  const b = parsed.data;
  const sets = [], vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.type !== undefined) set("type", b.type);
  if (b.title !== undefined) set("title", b.title);
  if (b.description !== undefined) set("description", b.description || null);
  if (b.unitLabel !== undefined) set("unit_label", b.unitLabel || null);
  if (b.targetValue !== undefined) set("target_value", b.targetValue);
  if (b.channelId !== undefined) set("channel_id", b.channelId || null);
  if (b.ownerId !== undefined) set("owner_id", b.ownerId || null);
  if (b.deadline !== undefined) set("deadline", b.deadline || null);
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  try {
    if (!(await assertChannelInOrg(pool, b.channelId, req.orgId))) {
      return res.status(400).json({ error: "Unknown channel." });
    }
    if (b.ownerId && !(await isOrgAdmin(pool, b.ownerId, req.orgId))) {
      return res.status(400).json({ error: "A goal can only be assigned to an admin." });
    }
    vals.push(req.params.id, req.orgId);
    const { rows } = await pool.query(
      `update goal set ${sets.join(", ")} where id = $${vals.length - 1} and org_id = $${vals.length} returning ${goalCols("")}`,
      vals,
    );
    if (!rows.length) return res.status(404).json({ error: "Goal not found." });
    res.json({ goal: rows[0] });
  } catch (err) { next(err); }
});

// Delete a goal — progress history cascades.
goalTrackerRouter.delete("/goal-tracker/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("delete from goal where id = $1 and org_id = $2", [req.params.id, req.orgId]);
    if (!rowCount) return res.status(404).json({ error: "Goal not found." });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
