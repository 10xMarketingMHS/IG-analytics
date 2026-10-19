import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import { pool } from "../db.js";
import { requireAdmin, requireEditor } from "../resolve-workspace.js";
import { requirePermission } from "../permissions.js";
import { resolveBudgetHours } from "./tasks.js";
import { hasColumn } from "../schema-flags.js";
import { capacityFor } from "../work-calendar.js";
import { monthPenalties, readSettings } from "../attendance.js";
import { isSuperHere } from "../super-admin.js";
import { scoreMonthAll } from "../goal-score.js";

export const goalsRouter = Router();

// Goal Setting — individual monthly capacity planning + performance tracking.
// Admin-only. Fully independent of Task Points / the leaderboard: nothing here
// feeds scoring. JPH = hours-per-job (the content type's time budget), and
// planned hours = Σ(JC × JPH). The jph is snapshotted onto each editor_goal row
// at save time, so later time-budget edits never rewrite past months' numbers.

const DEFAULT_CAPACITY = { working_days: 22, hours_per_day: 8 };

// Effective monthly capacity for an editor: their own override → the org-wide
// default for that month → carry-forward (most recent org default before it) →
// a constant. Returns the numbers plus which source they came from.
// A month with no saved capacity follows the work calendar (Settings ›
// General), when one is saved; before that, the last saved month carries on.
async function calendarCapacity(orgId, month) {
  if (!(await hasColumn("org", "settings"))) return null;
  // the org's settings, as attendance reads them (kept a few seconds)
  const cal = (await readSettings(orgId)).raw?.calendar;
  if (!cal) return null;
  const m = new Date(month);
  const c = capacityFor(cal, m.getUTCFullYear(), m.getUTCMonth());
  if (!c.workingDays) return null;
  return { working_days: c.workingDays, hours_per_day: Math.round((c.minutes / 60 / c.workingDays) * 10000) / 10000 };
}

// The team's capacity for a month when a person has none of their own: the
// org's for the month, the work calendar's, the org's latest earlier month, or
// the default. Read together, and kept 30 seconds (several goal screens ask at
// once); saving capacity or the work calendar clears it.
const orgCapCache = new Map(); // `${orgId}:${month}` -> { v, exp }
const ORG_CAP_TTL_MS = 30_000;
export function clearCapacityCache(orgId) {
  for (const k of orgCapCache.keys()) if (!orgId || k.startsWith(`${orgId}:`)) orgCapCache.delete(k);
}
async function orgCapacity(orgId, month) {
  const key = `${orgId}:${String(month).slice(0, 10)}`;
  const hit = orgCapCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const [org, fromCal, carry] = await Promise.all([
    pool.query("select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id is null and period_month=$2", [orgId, month]),
    calendarCapacity(orgId, month),
    pool.query("select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id is null and period_month < $2 order by period_month desc limit 1", [orgId, month]),
  ]);
  const v = org.rows[0] ? { ...org.rows[0], source: "org" }
    : fromCal ? { ...fromCal, source: "calendar" }
    : carry.rows[0] ? { ...carry.rows[0], source: "carry" }
    : { ...DEFAULT_CAPACITY, source: "default" };
  orgCapCache.set(key, { v, exp: Date.now() + ORG_CAP_TTL_MS });
  return v;
}

// A person's capacity for a month: their own, else the team's (above).
export async function effectiveCapacity(orgId, editorId, month) {
  const [own, team] = await Promise.all([
    editorId && editorId !== NIL_ID
      ? pool.query("select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id=$2 and period_month=$3", [orgId, editorId, month])
      : Promise.resolve({ rows: [] }),
    orgCapacity(orgId, month),
  ]);
  if (own.rows[0]) return { ...own.rows[0], source: "editor" };
  return { ...team };
}

export const capHours = (c) => Number(c.working_days) * Number(c.hours_per_day);

// Utilization status bands — mirror goal-setting.tsx (util < 75 Available,
// ≤ 95 Near Capacity, else Overloaded). argb fills for the exported Status cell.
function statusFor(util) {
  if (util < 75) return { label: "Available", fill: "FFDCFCE7" };
  if (util <= 95) return { label: "Near Capacity", fill: "FFFEF3C7" };
  return { label: "Overloaded", fill: "FFFEE2E2" };
}
const round1 = (n) => Math.round(n * 10) / 10;

// The 5 Admin Discipline criteria (columns on editor_discipline_points). The
// frontend's goalBreakdown derives the actual Discipline Points from these.
const CRITERIA = ["punctuality", "quality_responsibility", "behaviour", "attendance_availability", "deadline_adherence"];
const RATINGS_SELECT = CRITERIA.join(", ");
const ratingsOf = (row) => Object.fromEntries(CRITERIA.map((k) => [k, row && row[k] != null ? Number(row[k]) : null]));

// goal_setting_access is a READ-ONLY, strictly self-scoped grant: a grant-holder
// (non-admin) may only ever view their OWN editor's goals. When the caller
// reached the route on the grant, force the target to their own editor_id
// (ignoring any requested editorId); an admin's requested editorId is honored.
// A project's time is set in days (Settings › Tasks & time), not hours: each
// day counts as one full work day at the person's hours per day, so a 5-day
// project at 8 h a day takes 40 hours of their capacity. Every other type's
// hours per job are the ones the goal was saved with.
// "2026-10-19" or "2026-10" → "2026-10-01" (the period_month the goals use).
function monthStart(monthIn) {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(monthIn ?? ""));
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-01` : null;
}
const isProject = (f) => f.category === "project" && f.duration_days != null;
const projectHours = (f, hoursPerDay) => Number(f.duration_days) * Number(hoursPerDay || 0);
const jobHours = (f, storedJph, hoursPerDay) => (isProject(f) ? projectHours(f, hoursPerDay) : Number(storedJph));
// Everyone's capacity for a month: their own, else the org's (as effectiveCapacity).
const NIL_ID = "00000000-0000-0000-0000-000000000000";
async function capacityLookup(orgId, month) {
  const [own, orgEff] = await Promise.all([
    pool.query("select editor_id, working_days, hours_per_day from editor_capacity where org_id=$1 and period_month=$2 and editor_id is not null", [orgId, month]),
    effectiveCapacity(orgId, NIL_ID, month),
  ]);
  const m = new Map(own.rows.map((r) => [r.editor_id, { ...r, source: "editor" }]));
  return (editorId) => m.get(editorId) ?? orgEff;
}

async function scopedEditorId(req, requestedEditorId) {
  const g = req.viaGrant;
  // Admins and full-access grantees (edit_goals / discipline) may target any
  // editor; only a goal_setting_access-ONLY grantee is locked to their own.
  if (!g?.goal_setting_access || g.edit_goals || g.discipline) return requestedEditorId;
  const { rows } = await pool.query("select editor_id from app_user where id=$1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}
// The Goal Setting VIEW (Set Goals + Performance tabs) opens to any of these
// grants; edit/discipline writes have their own, narrower gates below.
const GOAL_VIEW_KEYS = ["goal_setting_access", "edit_goals", "discipline"];

// Reading goals: admins and the grants above as before; everyone else may read
// their OWN goals and progress (Goals › My goals) — treated exactly like a
// goal_setting_access grantee, so scopedEditorId locks them to themselves.
async function goalView(req, res, next) {
  try {
    if (req.role !== "admin") {
      const { rows } = await pool.query(
        "select permission_key from user_permission_grant where org_id=$1 and user_id=$2 and permission_key = any($3) and revoked_at is null",
        [req.orgId, req.user.sub, GOAL_VIEW_KEYS],
      );
      req.viaGrant ??= {};
      for (const r of rows) req.viaGrant[r.permission_key] = true;
      if (!rows.length) req.viaGrant.goal_setting_access = true;
    }
    next();
  } catch (err) {
    next(err);
  }
}

// GET /goals/totals?month=YYYY-MM — each editor's Goal Points total for the
// month: Σ(jc × the content type's points), the same figure Goal Setting's
// "Goal points" shows. Powers the Goal column on the Media House Leaders board,
// so it's readable by any workspace member (like the board itself) — no admin
// gate. Editors with no goals that month simply don't appear. Defaults to the
// current calendar month when no month is given.
goalsRouter.get("/goals/totals", async (req, res, next) => {
  try {
    const monthIn = req.query.month || new Date().toISOString().slice(0, 10);
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const { rows } = await pool.query(
      `select g.editor_id as "editorId", coalesce(sum(g.jc * coalesce((to_jsonb(g)->>'points')::numeric, cf.points)), 0)::float as "goalPoints"
         from editor_goal g
         join task_content_format cf on cf.id = g.content_format_id
        where g.org_id = $1 and g.period_month = $2
        group by g.editor_id`,
      [req.orgId, month],
    );
    res.json({ month, totals: rows });
  } catch (err) {
    next(err);
  }
});

// GET /goals?editorId=&month= — the goal-setting form for one editor+month:
// every active content type with its JC (blank = no goal) and JPH (stored goal
// jph, else pre-filled from the content type's time budget), plus the editor's
// effective capacity.
goalsRouter.get("/goals", goalView, async (req, res, next) => {
  const editorId = await scopedEditorId(req, req.query.editorId);
  const monthIn = req.query.month;
  if (!editorId || !monthIn) return res.status(400).json({ error: "editorId and month are required." });
  try {
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const { rows: formats } = await pool.query(
      "select id, name, icon, category, sort_order, points, duration_days from task_content_format where org_id=$1 and active order by category, sort_order, name",
      [req.orgId],
    );
    const { rows: goals } = await pool.query(
      "select content_format_id, jc, jph, (to_jsonb(editor_goal)->>'points')::numeric as pts from editor_goal where org_id=$1 and editor_id=$2 and period_month=$3",
      [req.orgId, editorId, month],
    );
    const cap = await effectiveCapacity(req.orgId, editorId, month);
    const goalBy = new Map(goals.map((g) => [g.content_format_id, g]));
    const rows = [];
    for (const f of formats) {
      const g = goalBy.get(f.id);
      // The type's time (Settings › Tasks & time) for this editor — what Set
      // goals shows as hours per job; it pre-fills JPH when no goal exists yet.
      // A project's days count as full work days.
      const budget = isProject(f) ? projectHours(f, cap.hours_per_day) : await resolveBudgetHours(req.orgId, editorId, f.id);
      rows.push({
        contentFormatId: f.id, name: f.name, icon: f.icon, category: f.category,
        // a goal already set keeps the points it was set with
        points: g && g.pts != null ? Number(g.pts) : Number(f.points),
        jc: g ? Number(g.jc) : null,
        jph: g && !isProject(f) ? Number(g.jph) : (budget != null ? Number(budget) : 0),
        budget: budget != null ? Number(budget) : null,
        durationDays: isProject(f) ? Number(f.duration_days) : null,
      });
    }
    const orgDefault = (await pool.query(
      "select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id is null and period_month=$2",
      [req.orgId, month],
    )).rows[0] ?? null;
    const editorOverride = (await pool.query(
      "select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id=$2 and period_month=$3",
      [req.orgId, editorId, month],
    )).rows[0] ?? null;
    res.json({
      month,
      capacity: { workingDays: Number(cap.working_days), hoursPerDay: Number(cap.hours_per_day), hours: capHours(cap), source: cap.source },
      orgDefault: orgDefault && { workingDays: Number(orgDefault.working_days), hoursPerDay: Number(orgDefault.hours_per_day) },
      editorOverride: editorOverride && { workingDays: Number(editorOverride.working_days), hoursPerDay: Number(editorOverride.hours_per_day) },
      rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /goals/set-all?month= — Set goals for everyone at once: each active
// person's GET /goals answer, from a handful of queries. (One request per
// person ran ~14 queries each, most in a row, through a pool of 5 connections
// to a remote database: with a full team the screen sat on Loading.)
goalsRouter.get("/goals/set-all", requirePermission("edit_goals"), async (req, res, next) => {
  const monthIn = req.query.month;
  if (!monthIn) return res.status(400).json({ error: "month is required." });
  try {
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const [eds, formats, goals, rules, caps, orgEff] = await Promise.all([
      pool.query("select id from editor where org_id=$1 and active", [req.orgId]),
      pool.query("select id, name, icon, category, sort_order, points, duration_days from task_content_format where org_id=$1 and active order by category, sort_order, name", [req.orgId]),
      pool.query("select editor_id, content_format_id, jc, jph, (to_jsonb(editor_goal)->>'points')::numeric as pts from editor_goal where org_id=$1 and period_month=$2", [req.orgId, month]),
      pool.query("select content_format_id, editor_id, hours from task_time_rule where org_id=$1", [req.orgId]),
      pool.query("select editor_id, working_days, hours_per_day from editor_capacity where org_id=$1 and period_month=$2", [req.orgId, month]),
      // a person with no capacity of their own gets the org's (or the calendar's)
      effectiveCapacity(req.orgId, NIL_ID, month),
    ]);
    // the type's time for a person: theirs, else the org's (as resolveBudgetHours)
    const rule = new Map(rules.rows.map((r) => [`${r.content_format_id}:${r.editor_id ?? ""}`, r.hours]));
    const budgetOf = (editorId, formatId) => rule.get(`${formatId}:${editorId}`) ?? rule.get(`${formatId}:`) ?? null;
    const goalBy = new Map(goals.rows.map((g) => [`${g.editor_id}:${g.content_format_id}`, g]));
    const capOf = (r) => r && { workingDays: Number(r.working_days), hoursPerDay: Number(r.hours_per_day) };
    const orgRow = caps.rows.find((r) => r.editor_id == null) ?? null;
    const people = {};
    for (const { id } of eds.rows) {
      const own = caps.rows.find((r) => r.editor_id === id) ?? null;
      const cap = own ? { ...own, source: "editor" } : orgEff;
      people[id] = {
        month,
        capacity: { workingDays: Number(cap.working_days), hoursPerDay: Number(cap.hours_per_day), hours: capHours(cap), source: cap.source },
        orgDefault: capOf(orgRow),
        editorOverride: capOf(own),
        rows: formats.rows.map((f) => {
          const g = goalBy.get(`${id}:${f.id}`);
          const budget = isProject(f) ? projectHours(f, cap.hours_per_day) : budgetOf(id, f.id);
          return {
            contentFormatId: f.id, name: f.name, icon: f.icon, category: f.category,
            points: g && g.pts != null ? Number(g.pts) : Number(f.points),
            jc: g ? Number(g.jc) : null,
            jph: g && !isProject(f) ? Number(g.jph) : (budget != null ? Number(budget) : 0),
            budget: budget != null ? Number(budget) : null,
            durationDays: isProject(f) ? Number(f.duration_days) : null,
          };
        }),
      };
    }
    res.json({ month, people });
  } catch (err) {
    next(err);
  }
});

// GET /goals/performance-all?month= — Team goals for everyone at once: each
// person's GET /goals/performance rows. Only your own unless you oversee goals.
goalsRouter.get("/goals/performance-all", goalView, async (req, res, next) => {
  const monthIn = req.query.month;
  if (!monthIn) return res.status(400).json({ error: "month is required." });
  try {
    const g0 = req.viaGrant;
    const overseer = !g0?.goal_setting_access || g0.edit_goals || g0.discipline;
    const self = overseer ? null : await scopedEditorId(req, null);
    if (!overseer && !self) return res.json({ month: monthIn, people: {} });
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const one = self ? " and g.editor_id = $3" : "";
    const P = self ? [req.orgId, month, self] : [req.orgId, month];
    const [goals, actuals, scores, capOf] = await Promise.all([
      pool.query(
        `select g.editor_id, g.content_format_id, g.jc, g.jph, cf.name, cf.icon, cf.category, cf.sort_order, cf.duration_days,
                coalesce((to_jsonb(g)->>'points')::numeric, cf.points) as points
           from editor_goal g join task_content_format cf on cf.id = g.content_format_id
          where g.org_id=$1 and g.period_month=$2${one}
          order by cf.category, cf.sort_order, cf.name`,
        P,
      ),
      pool.query(
        `select editor_id, content_format_id, count(*)::int actual
           from task
          where org_id=$1 and status='done' and content_format_id is not null
            and completed_at >= $2 and completed_at < ($2::date + interval '1 month')${self ? " and editor_id = $3" : ""}
          group by editor_id, content_format_id`,
        P,
      ),
      scoreMonthAll(req.orgId, String(month).slice(0, 10), self),
      capacityLookup(req.orgId, month),
    ]);
    const actualBy = new Map(actuals.rows.map((a) => [`${a.editor_id}:${a.content_format_id}`, a.actual]));
    const people = {};
    for (const g of goals.rows) {
      const scored = scores.get(g.editor_id);
      const t = (scored?.types ?? []).find((x) => x.contentFormatId === g.content_format_id);
      const goalJC = Number(g.jc), jph = jobHours(g, g.jph, capOf(g.editor_id).hours_per_day);
      const actualJC = actualBy.get(`${g.editor_id}:${g.content_format_id}`) ?? 0;
      (people[g.editor_id] ??= { rows: [] }).rows.push({
        contentFormatId: g.content_format_id, name: g.name, icon: g.icon, category: g.category,
        goalJC, actualJC, jph, points: Number(g.points),
        goalHours: goalJC * jph, actualHours: actualJC * jph,
        balance: goalJC * jph - actualJC * jph,
        achievement: goalJC > 0 ? (actualJC / goalJC) * 100 : null,
        goalAdjusted: t ? Math.round(t.goal * 10) / 10 : goalJC,
        covered: scored?.coveredByType?.[g.content_format_id] ?? 0,
      });
    }
    res.json({ month, people });
  } catch (err) {
    next(err);
  }
});

const CapacitySchema = z.object({
  scope: z.enum(["org", "editor"]),
  editorId: z.string().uuid().optional(),
  month: z.string(),
  workingDays: z.number().int().min(0).max(31),
  hoursPerDay: z.number().min(0).max(24),
});

// PUT /goals/capacity — set the org-wide default (scope 'org') or one editor's
// override (scope 'editor') for a month.
goalsRouter.put("/goals/capacity", requirePermission("edit_goals"), async (req, res, next) => {
  const parsed = CapacitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid capacity." });
  const d = parsed.data;
  if (d.scope === "editor" && !d.editorId) return res.status(400).json({ error: "editorId is required for an editor override." });
  try {
    // The team's capacity comes from the work calendar: the Super Admin's call.
    if (d.scope === "org" && !(await isSuperHere(req))) {
      return res.status(403).json({ error: "Only a Super Admin can change the work calendar." });
    }
    const month = monthStart(d.month);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const editorId = d.scope === "editor" ? d.editorId : null;
    // Upsert — the two scopes have separate partial unique indexes, so update-
    // else-insert keeps it simple across both.
    const upd = await pool.query(
      `update editor_capacity set working_days=$4, hours_per_day=$5, updated_at=now()
        where org_id=$1 and period_month=$2 and editor_id is not distinct from $3`,
      [req.orgId, month, editorId, d.workingDays, d.hoursPerDay],
    );
    if (upd.rowCount === 0) {
      await pool.query(
        "insert into editor_capacity (org_id, editor_id, period_month, working_days, hours_per_day) values ($1,$2,$3,$4,$5)",
        [req.orgId, editorId, month, d.workingDays, d.hoursPerDay],
      );
    }
    clearCapacityCache(req.orgId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const GoalsSchema = z.object({
  editorId: z.string().uuid(),
  month: z.string(),
  goals: z.array(z.object({
    contentFormatId: z.string().uuid(),
    jc: z.number().int().min(0).nullable(),
    jph: z.number().min(0),
  })),
});

// PUT /goals — save one editor's goals for a month. A row with jc = null means
// "no goal for this type" and is deleted; otherwise it's upserted with its
// snapshotted jph.
goalsRouter.put("/goals", requirePermission("edit_goals"), async (req, res, next) => {
  const parsed = GoalsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid goals." });
  const d = parsed.data;
  try {
    const month = monthStart(d.month);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    for (const g of d.goals) {
      if (g.jc == null) {
        await pool.query(
          "delete from editor_goal where org_id=$1 and editor_id=$2 and content_format_id=$3 and period_month=$4",
          [req.orgId, d.editorId, g.contentFormatId, month],
        );
      } else {
        // A new goal takes the type's points today and keeps them; changing
        // its count later doesn't change its points.
        const withPoints = await hasColumn("editor_goal", "points");
        await pool.query(
          withPoints
            ? `insert into editor_goal (org_id, editor_id, content_format_id, period_month, jc, jph, points)
               values ($1,$2,$3,$4,$5,$6, (select points from task_content_format where id = $3))
               on conflict (org_id, editor_id, content_format_id, period_month)
               do update set jc = excluded.jc, jph = excluded.jph, points = coalesce(editor_goal.points, excluded.points), updated_at = now()`
            : `insert into editor_goal (org_id, editor_id, content_format_id, period_month, jc, jph)
               values ($1,$2,$3,$4,$5,$6)
               on conflict (org_id, editor_id, content_format_id, period_month)
               do update set jc = excluded.jc, jph = excluded.jph, updated_at = now()`,
          [req.orgId, d.editorId, g.contentFormatId, month, g.jc, g.jph],
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /goals/performance?editorId=&month= — read-only monthly performance:
// Goal JC vs Actual JC (completed tasks of that content type in the month),
// with Goal/Actual hours from the SAME stored jph, balance and achievement %.
goalsRouter.get("/goals/performance", goalView, async (req, res, next) => {
  const editorId = await scopedEditorId(req, req.query.editorId);
  const monthIn = req.query.month;
  if (!editorId || !monthIn) return res.status(400).json({ error: "editorId and month are required." });
  try {
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const { rows: goals } = await pool.query(
      `select g.content_format_id, g.jc, g.jph, cf.name, cf.icon, cf.category, cf.duration_days, coalesce((to_jsonb(g)->>'points')::numeric, cf.points) as points
         from editor_goal g join task_content_format cf on cf.id = g.content_format_id
        where g.org_id=$1 and g.editor_id=$2 and g.period_month=$3
        order by cf.category, cf.sort_order, cf.name`,
      [req.orgId, editorId, month],
    );
    // Actual completed counts per content type this month (admin tasks have a
    // null content_format_id, so they never appear here).
    const { rows: actuals } = await pool.query(
      `select content_format_id, count(*)::int actual
         from task
        where org_id=$1 and editor_id=$2 and status='done' and content_format_id is not null
          and completed_at >= $3 and completed_at < ($3::date + interval '1 month')
        group by content_format_id`,
      [req.orgId, editorId, month],
    );
    const actualBy = new Map(actuals.map((a) => [a.content_format_id, a.actual]));
    const scored = (await scoreMonthAll(req.orgId, String(month).slice(0, 10), editorId)).get(editorId);
    const typed = new Map((scored?.types ?? []).map((t) => [t.contentFormatId, t]));
    const hoursPerDay = (await effectiveCapacity(req.orgId, editorId, month)).hours_per_day;
    const rows = goals.map((g) => {
      const goalJC = Number(g.jc);
      const jph = jobHours(g, g.jph, hoursPerDay);
      const actualJC = actualBy.get(g.content_format_id) ?? 0;
      const t = typed.get(g.content_format_id);
      const goalHours = goalJC * jph;
      const actualHours = actualJC * jph;
      return {
        contentFormatId: g.content_format_id, name: g.name, icon: g.icon, category: g.category,
        goalJC, actualJC, jph, points: Number(g.points),
        goalHours, actualHours,
        balance: goalHours - actualHours,
        achievement: goalJC > 0 ? (actualJC / goalJC) * 100 : null,
        // the goal after approved leave, and jobs taken over from someone
        goalAdjusted: t ? Math.round(t.goal * 10) / 10 : goalJC,
        covered: scored?.coveredByType?.[g.content_format_id] ?? 0,
      };
    });
    // Stored Admin Discipline criterion ratings for this editor+month.
    const disc = (await pool.query(
      `select ${RATINGS_SELECT}, note from editor_discipline_points where org_id=$1 and editor_id=$2 and period_month=$3`,
      [req.orgId, editorId, month],
    )).rows[0];
    res.json({
      month, rows, ratings: ratingsOf(disc), note: disc?.note ?? null,
      leaveDays: scored?.leaveDays ?? 0, workingDays: scored?.workingDays ?? 0,
      coveredJobs: scored?.coveredJobs ?? 0, coveredPoints: scored?.coveredPoints ?? 0,
      scorePct: scored?.pct == null ? null : Math.round(scored.pct * 10) / 10,
    });
  } catch (err) {
    next(err);
  }
});

// GET /goals/months — the period_months that actually have goal data, newest
// first, so the export/performance picker only offers real periods.
goalsRouter.get("/goals/months", goalView, async (req, res, next) => {
  try {
    // Self-scoped for a goal_setting_access-only grantee: only the months THEY
    // have goals in — never a hint of which other editors have data. Admins and
    // full-access grantees (edit_goals / discipline) get every month.
    const self = await scopedEditorId(req, null);
    const { rows } = self
      ? await pool.query(
          "select distinct to_char(period_month, 'YYYY-MM') m from editor_goal where org_id=$1 and editor_id=$2 order by m desc",
          [req.orgId, self],
        )
      : await pool.query(
          "select distinct to_char(period_month, 'YYYY-MM') m from editor_goal where org_id=$1 order by m desc",
          [req.orgId],
        );
    res.json({ months: rows.map((r) => r.m) });
  } catch (err) {
    next(err);
  }
});

// GET /goals/export?month=YYYY-MM — a two-sheet .xlsx for the month (Goal
// Setting + Performance), all editors. Admin-only. A month with no goals still
// returns a valid workbook (headers only), never a 500.
goalsRouter.get("/goals/export", requireAdmin, async (req, res, next) => {
  const monthIn = req.query.month;
  if (!monthIn) return res.status(400).json({ error: "month is required." });
  try {
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const monthStr = String(monthIn).slice(0, 7);

    const { rows: goals } = await pool.query(
      `select g.editor_id, e.name editor_name, g.content_format_id, cf.name cf_name,
              cf.category, cf.sort_order, cf.duration_days, g.jc, g.jph
         from editor_goal g
         join editor e on e.id = g.editor_id
         join task_content_format cf on cf.id = g.content_format_id
        where g.org_id=$1 and g.period_month=$2
        order by e.name, cf.category, cf.sort_order, cf.name`,
      [req.orgId, month],
    );
    const { rows: actuals } = await pool.query(
      `select editor_id, content_format_id, count(*)::int actual
         from task
        where org_id=$1 and status='done' and content_format_id is not null
          and completed_at >= $2 and completed_at < ($2::date + interval '1 month')
        group by editor_id, content_format_id`,
      [req.orgId, month],
    );
    const actualBy = new Map(actuals.map((a) => [`${a.editor_id}:${a.content_format_id}`, a.actual]));

    // Editors (in name order) and the content types that have any goal this
    // month (in their configured order) — both derived from the data, dynamic.
    const editors = [];
    const seenEd = new Set();
    const ctypes = [];
    const seenCt = new Set();
    for (const g of goals) {
      if (!seenEd.has(g.editor_id)) { seenEd.add(g.editor_id); editors.push({ id: g.editor_id, name: g.editor_name }); }
      if (!seenCt.has(g.content_format_id)) { seenCt.add(g.content_format_id); ctypes.push({ id: g.content_format_id, name: g.cf_name }); }
    }
    const goalBy = new Map(goals.map((g) => [`${g.editor_id}:${g.content_format_id}`, g]));
    // hours per job, with a project's days as full work days
    const capOf = await capacityLookup(req.orgId, month);
    const jphOf = (g) => jobHours(g, g.jph, capOf(g.editor_id).hours_per_day);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Pulse";

    // --- Sheet 1: Goal Setting (wide, one row per editor) ---
    const s1 = wb.addWorksheet("Goal Setting");
    const s1head = ["Editor Name", "Monthly Capacity (Hrs)", "Planned Hours", "Balance Hours", "Utilization %", "Status"];
    for (const ct of ctypes) { s1head.push(`${ct.name} JC`, `${ct.name} JPH`); }
    s1.addRow(s1head);
    for (const ed of editors) {
      const own = goals.filter((g) => g.editor_id === ed.id);
      const planned = own.reduce((s, g) => s + Number(g.jc) * jphOf(g), 0);
      const cap = capOf(ed.id);
      const capH = capHours(cap);
      const util = capH > 0 ? (planned / capH) * 100 : 0;
      const st = statusFor(util);
      const row = [ed.name, round1(capH), round1(planned), round1(capH - planned), round1(util), st.label];
      for (const ct of ctypes) {
        const g = goalBy.get(`${ed.id}:${ct.id}`);
        row.push(g ? Number(g.jc) : null, g ? jphOf(g) : null);
      }
      const added = s1.addRow(row);
      added.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: st.fill } };
    }

    // --- Sheet 2: Performance (one row per editor × content type with a goal) ---
    const s2 = wb.addWorksheet("Performance");
    s2.addRow(["Editor Name", "Content Type", "Goal JC", "Actual JC", "Goal Hours", "Actual Hours", "Balance", "Achievement %"]);
    for (const g of goals) {
      const goalJC = Number(g.jc), jph = jphOf(g);
      const actualJC = actualBy.get(`${g.editor_id}:${g.content_format_id}`) ?? 0;
      const goalHours = goalJC * jph, actualHours = actualJC * jph;
      s2.addRow([
        g.editor_name, g.cf_name, goalJC, actualJC,
        round1(goalHours), round1(actualHours), round1(goalHours - actualHours),
        goalJC > 0 ? round1((actualJC / goalJC) * 100) : null,
      ]);
    }

    for (const sh of [s1, s2]) {
      sh.getRow(1).font = { bold: true };
      sh.columns.forEach((c) => { c.width = Math.max(12, (c.values ?? []).reduce((m, v) => Math.max(m, String(v ?? "").length + 2), 12)); });
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="goal-setting-${monthStr}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

// GET /goals/discipline?month= — admin bulk view: one entry per active editor
// with the raw per-type goal/actual/points data (frontend computes Total/Earned/
// Overall via the shared goalBreakdown), plus the stored Discipline Points/note.
goalsRouter.get("/goals/discipline", requirePermission("discipline"), async (req, res, next) => {
  const monthIn = req.query.month;
  if (!monthIn) return res.status(400).json({ error: "month is required." });
  try {
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    // Each person's month, scored by the one rule (goal-score.js): goals cut for
    // approved leave, each type up to 150%, covered work on top; their ratings;
    // and the attendance points lost this month (late, absent), which come off
    // discipline. All read together.
    const [{ rows: editors }, scores, { rows: disc }, penalties] = await Promise.all([
      pool.query("select id, name from editor where org_id=$1 and active order by name", [req.orgId]),
      scoreMonthAll(req.orgId, String(month).slice(0, 10)),
      pool.query(
        `select editor_id, ${RATINGS_SELECT}, note, updated_at from editor_discipline_points where org_id=$1 and period_month=$2`,
        [req.orgId, month],
      ),
      monthPenalties(req.orgId, String(month).slice(0, 7)),
    ]);
    const discBy = new Map(disc.map((d) => [d.editor_id, d]));
    const rowsOf = (s) => (s?.types ?? []).map((t) => ({ goalJC: t.goal, actualJC: t.done, countedJC: t.counted, points: t.points }));
    res.json({
      month,
      editors: editors.map((e) => {
        const d = discBy.get(e.id);
        return {
          editorId: e.id, editorName: e.name,
          rows: rowsOf(scores.get(e.id)),
          coveredPoints: scores.get(e.id)?.coveredPoints ?? 0,
          leaveDays: scores.get(e.id)?.leaveDays ?? 0,
          ratings: ratingsOf(d),
          attendancePenalty: penalties.get(e.id) ?? 0,
          note: d?.note ?? null,
          updatedAt: d?.updated_at ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

const rating = z.number().int().min(0).max(5).nullable();
const DisciplineSchema = z.object({
  month: z.string(),
  entries: z.array(z.object({
    editorId: z.string().uuid(),
    ratings: z.object({
      punctuality: rating, quality_responsibility: rating, behaviour: rating,
      attendance_availability: rating, deadline_adherence: rating,
    }).partial(),
    note: z.string().max(2000).nullable().optional(),
  })),
});

// PUT /goals/discipline — admin bulk save of the 5 criterion ratings per editor.
// Each rating is bounded [0,5] (zod). Discipline Points themselves are derived
// live from these ratings + the editor's live ceiling, never stored.
goalsRouter.put("/goals/discipline", requirePermission("discipline"), async (req, res, next) => {
  const parsed = DisciplineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ratings must each be 0–5." });
  const d = parsed.data;
  try {
    const month = monthStart(d.month);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    for (const e of d.entries) {
      const vals = CRITERIA.map((k) => e.ratings[k] ?? null);
      await pool.query(
        `insert into editor_discipline_points
           (org_id, editor_id, period_month, ${RATINGS_SELECT}, note, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         on conflict (org_id, editor_id, period_month) do update set
           punctuality = excluded.punctuality,
           quality_responsibility = excluded.quality_responsibility,
           behaviour = excluded.behaviour,
           attendance_availability = excluded.attendance_availability,
           deadline_adherence = excluded.deadline_adherence,
           note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
        [req.orgId, e.editorId, month, ...vals, e.note ?? null, req.user.sub],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /goals/my-breakdown?month= — the caller's OWN raw goal/actual/points data
// + stored discipline for the month (My Day). Editor-facing, read-only; never
// exposes anyone else's figures.
goalsRouter.get("/goals/my-breakdown", requireEditor, async (req, res, next) => {
  const monthIn = req.query.month;
  if (!monthIn) return res.status(400).json({ error: "month is required." });
  try {
    const editorId = (await pool.query("select editor_id from app_user where id=$1", [req.user.sub])).rows[0]?.editor_id;
    if (!editorId) return res.json({ month: monthIn, rows: [], discipline: null, note: null, unlinked: true });
    const month = monthStart(monthIn);
    if (!month) return res.status(400).json({ error: "That month couldn't be read." });
    const scored = (await scoreMonthAll(req.orgId, String(month).slice(0, 10), editorId)).get(editorId);
    const disc = (await pool.query(
      `select ${RATINGS_SELECT}, note from editor_discipline_points where org_id=$1 and editor_id=$2 and period_month=$3`,
      [req.orgId, editorId, month],
    )).rows[0];
    res.json({
      month,
      rows: (scored?.types ?? []).map((t) => ({ goalJC: t.goal, actualJC: t.done, countedJC: t.counted, points: t.points })),
      coveredPoints: scored?.coveredPoints ?? 0,
      leaveDays: scored?.leaveDays ?? 0,
      ratings: ratingsOf(disc),
      note: disc?.note ?? null,
    });
  } catch (err) {
    next(err);
  }
});
