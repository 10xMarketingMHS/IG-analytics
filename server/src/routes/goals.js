import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import { pool } from "../db.js";
import { requireAdmin, requireEditor } from "../resolve-workspace.js";
import { requirePermission } from "../permissions.js";
import { resolveBudgetHours } from "./tasks.js";

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
async function effectiveCapacity(orgId, editorId, month) {
  const q = (sql, params) => pool.query(sql, params);
  let r = await q(
    "select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id=$2 and period_month=$3",
    [orgId, editorId, month],
  );
  if (r.rows[0]) return { ...r.rows[0], source: "editor" };
  r = await q(
    "select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id is null and period_month=$2",
    [orgId, month],
  );
  if (r.rows[0]) return { ...r.rows[0], source: "org" };
  r = await q(
    "select working_days, hours_per_day from editor_capacity where org_id=$1 and editor_id is null and period_month < $2 order by period_month desc limit 1",
    [orgId, month],
  );
  if (r.rows[0]) return { ...r.rows[0], source: "carry" };
  return { ...DEFAULT_CAPACITY, source: "default" };
}

const capHours = (c) => Number(c.working_days) * Number(c.hours_per_day);

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
const GOAL_VIEW = { message: "You don't have access to Goal Setting." };

// GET /goals?editorId=&month= — the goal-setting form for one editor+month:
// every active content type with its JC (blank = no goal) and JPH (stored goal
// jph, else pre-filled from the content type's time budget), plus the editor's
// effective capacity.
goalsRouter.get("/goals", requirePermission(GOAL_VIEW_KEYS, GOAL_VIEW), async (req, res, next) => {
  const editorId = await scopedEditorId(req, req.query.editorId);
  const monthIn = req.query.month;
  if (!editorId || !monthIn) return res.status(400).json({ error: "editorId and month are required." });
  try {
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [monthIn]);
    const month = mrow[0].m;
    const { rows: formats } = await pool.query(
      "select id, name, icon, category, sort_order, points from task_content_format where org_id=$1 and active order by category, sort_order, name",
      [req.orgId],
    );
    const { rows: goals } = await pool.query(
      "select content_format_id, jc, jph from editor_goal where org_id=$1 and editor_id=$2 and period_month=$3",
      [req.orgId, editorId, month],
    );
    const goalBy = new Map(goals.map((g) => [g.content_format_id, g]));
    const rows = [];
    for (const f of formats) {
      const g = goalBy.get(f.id);
      // Pre-fill JPH from the content type's time budget when no goal exists yet.
      const budget = g ? null : await resolveBudgetHours(req.orgId, editorId, f.id);
      rows.push({
        contentFormatId: f.id, name: f.name, icon: f.icon, category: f.category,
        points: Number(f.points),
        jc: g ? Number(g.jc) : null,
        jph: g ? Number(g.jph) : (budget != null ? Number(budget) : 0),
      });
    }
    const cap = await effectiveCapacity(req.orgId, editorId, month);
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
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [d.month]);
    const month = mrow[0].m;
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
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [d.month]);
    const month = mrow[0].m;
    for (const g of d.goals) {
      if (g.jc == null) {
        await pool.query(
          "delete from editor_goal where org_id=$1 and editor_id=$2 and content_format_id=$3 and period_month=$4",
          [req.orgId, d.editorId, g.contentFormatId, month],
        );
      } else {
        await pool.query(
          `insert into editor_goal (org_id, editor_id, content_format_id, period_month, jc, jph)
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
goalsRouter.get("/goals/performance", requirePermission(GOAL_VIEW_KEYS, GOAL_VIEW), async (req, res, next) => {
  const editorId = await scopedEditorId(req, req.query.editorId);
  const monthIn = req.query.month;
  if (!editorId || !monthIn) return res.status(400).json({ error: "editorId and month are required." });
  try {
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [monthIn]);
    const month = mrow[0].m;
    const { rows: goals } = await pool.query(
      `select g.content_format_id, g.jc, g.jph, cf.name, cf.icon, cf.category, cf.points
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
    const rows = goals.map((g) => {
      const goalJC = Number(g.jc);
      const jph = Number(g.jph);
      const actualJC = actualBy.get(g.content_format_id) ?? 0;
      const goalHours = goalJC * jph;
      const actualHours = actualJC * jph;
      return {
        contentFormatId: g.content_format_id, name: g.name, icon: g.icon, category: g.category,
        goalJC, actualJC, jph, points: Number(g.points),
        goalHours, actualHours,
        balance: goalHours - actualHours,
        achievement: goalJC > 0 ? (actualJC / goalJC) * 100 : null,
      };
    });
    // Stored Admin Discipline criterion ratings for this editor+month.
    const disc = (await pool.query(
      `select ${RATINGS_SELECT}, note from editor_discipline_points where org_id=$1 and editor_id=$2 and period_month=$3`,
      [req.orgId, editorId, month],
    )).rows[0];
    res.json({ month, rows, ratings: ratingsOf(disc), note: disc?.note ?? null });
  } catch (err) {
    next(err);
  }
});

// GET /goals/months — the period_months that actually have goal data, newest
// first, so the export/performance picker only offers real periods.
goalsRouter.get("/goals/months", requirePermission(GOAL_VIEW_KEYS, GOAL_VIEW), async (req, res, next) => {
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
    const { rows: mrow } = await pool.query("select date_trunc('month', ($1||'-01')::date)::date m", [String(monthIn).slice(0, 7)]);
    const month = mrow[0].m;
    const monthStr = String(monthIn).slice(0, 7);

    const { rows: goals } = await pool.query(
      `select g.editor_id, e.name editor_name, g.content_format_id, cf.name cf_name,
              cf.category, cf.sort_order, g.jc, g.jph
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

    const wb = new ExcelJS.Workbook();
    wb.creator = "Pulse";

    // --- Sheet 1: Goal Setting (wide, one row per editor) ---
    const s1 = wb.addWorksheet("Goal Setting");
    const s1head = ["Editor Name", "Monthly Capacity (Hrs)", "Planned Hours", "Balance Hours", "Utilization %", "Status"];
    for (const ct of ctypes) { s1head.push(`${ct.name} JC`, `${ct.name} JPH`); }
    s1.addRow(s1head);
    for (const ed of editors) {
      const own = goals.filter((g) => g.editor_id === ed.id);
      const planned = own.reduce((s, g) => s + Number(g.jc) * Number(g.jph), 0);
      const cap = await effectiveCapacity(req.orgId, ed.id, month);
      const capH = capHours(cap);
      const util = capH > 0 ? (planned / capH) * 100 : 0;
      const st = statusFor(util);
      const row = [ed.name, round1(capH), round1(planned), round1(capH - planned), round1(util), st.label];
      for (const ct of ctypes) {
        const g = goalBy.get(`${ed.id}:${ct.id}`);
        row.push(g ? Number(g.jc) : null, g ? Number(g.jph) : null);
      }
      const added = s1.addRow(row);
      added.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: st.fill } };
    }

    // --- Sheet 2: Performance (one row per editor × content type with a goal) ---
    const s2 = wb.addWorksheet("Performance");
    s2.addRow(["Editor Name", "Content Type", "Goal JC", "Actual JC", "Goal Hours", "Actual Hours", "Balance", "Achievement %"]);
    for (const g of goals) {
      const goalJC = Number(g.jc), jph = Number(g.jph);
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
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [monthIn]);
    const month = mrow[0].m;
    const { rows: editors } = await pool.query(
      "select id, name from editor where org_id=$1 and active order by name", [req.orgId],
    );
    const { rows: goals } = await pool.query(
      `select g.editor_id, g.content_format_id, g.jc, cf.points
         from editor_goal g join task_content_format cf on cf.id = g.content_format_id
        where g.org_id=$1 and g.period_month=$2`,
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
    const { rows: disc } = await pool.query(
      `select editor_id, ${RATINGS_SELECT}, note, updated_at from editor_discipline_points where org_id=$1 and period_month=$2`,
      [req.orgId, month],
    );
    const actualBy = new Map(actuals.map((a) => [`${a.editor_id}:${a.content_format_id}`, a.actual]));
    const discBy = new Map(disc.map((d) => [d.editor_id, d]));
    const goalsByEd = new Map();
    for (const g of goals) {
      if (!goalsByEd.has(g.editor_id)) goalsByEd.set(g.editor_id, []);
      goalsByEd.get(g.editor_id).push({
        goalJC: Number(g.jc),
        actualJC: actualBy.get(`${g.editor_id}:${g.content_format_id}`) ?? 0,
        points: Number(g.points),
      });
    }
    res.json({
      month,
      editors: editors.map((e) => {
        const d = discBy.get(e.id);
        return {
          editorId: e.id, editorName: e.name,
          rows: goalsByEd.get(e.id) ?? [],
          ratings: ratingsOf(d),
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
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [d.month]);
    const month = mrow[0].m;
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
    const { rows: mrow } = await pool.query("select date_trunc('month', $1::date)::date m", [monthIn]);
    const month = mrow[0].m;
    const { rows: goals } = await pool.query(
      `select g.content_format_id, g.jc, cf.points
         from editor_goal g join task_content_format cf on cf.id = g.content_format_id
        where g.org_id=$1 and g.editor_id=$2 and g.period_month=$3`,
      [req.orgId, editorId, month],
    );
    const { rows: actuals } = await pool.query(
      `select content_format_id, count(*)::int actual from task
        where org_id=$1 and editor_id=$2 and status='done' and content_format_id is not null
          and completed_at >= $3 and completed_at < ($3::date + interval '1 month')
        group by content_format_id`,
      [req.orgId, editorId, month],
    );
    const actualBy = new Map(actuals.map((a) => [a.content_format_id, a.actual]));
    const disc = (await pool.query(
      `select ${RATINGS_SELECT}, note from editor_discipline_points where org_id=$1 and editor_id=$2 and period_month=$3`,
      [req.orgId, editorId, month],
    )).rows[0];
    res.json({
      month,
      rows: goals.map((g) => ({ goalJC: Number(g.jc), actualJC: actualBy.get(g.content_format_id) ?? 0, points: Number(g.points) })),
      ratings: ratingsOf(disc),
      note: disc?.note ?? null,
    });
  } catch (err) {
    next(err);
  }
});
