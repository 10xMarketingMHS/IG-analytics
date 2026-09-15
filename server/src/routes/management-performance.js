import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";
import { effectiveCapacity, capHours } from "./goals.js";

// Management Performance (EPI / MPI / LPI). Admin-only. Each editor's monthly
// "Completed Hours" — the actual tracked timer time on tasks they completed that
// month — measured against their OWN monthly goal capacity (reused from Goal
// Setting's editor_capacity), then banded by org-wide percentage thresholds.
//
// Snapshot principle (mirrors task budgets / editor_goal.jph): a past month's
// numbers freeze into editor_monthly_performance with the thresholds that were
// actually applied, so a later threshold edit never rewrites history. The
// current, in-progress month is recomputed and re-snapshotted on every view.
export const managementPerformanceRouter = Router();

const DEFAULT_THRESHOLDS = { epiMinPct: 93.75, mpiMinPct: 83.3 };

function thisMonthFirst() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Resolve a 'YYYY-MM' (or 'YYYY-MM-DD') to a canonical first-of-month date.
async function firstOfMonth(monthIn) {
  const { rows } = await pool.query(
    "select date_trunc('month', (($1)::text || case when length(($1)::text) = 7 then '-01' else '' end)::date)::date::text m",
    [String(monthIn).slice(0, 10)],
  );
  return rows[0].m; // 'YYYY-MM-DD'
}

// The org's single threshold row, or the built-in defaults if unset.
async function getThresholds(orgId) {
  const { rows } = await pool.query(
    "select epi_min_pct, mpi_min_pct from performance_threshold where org_id = $1",
    [orgId],
  );
  if (!rows[0]) return { ...DEFAULT_THRESHOLDS, isDefault: true };
  return {
    epiMinPct: Number(rows[0].epi_min_pct),
    mpiMinPct: Number(rows[0].mpi_min_pct),
    isDefault: false,
  };
}

// EPI/MPI/LPI from completion % of the editor's own monthly goal. EPI is
// open-ended upward — exceeding the goal stays EPI.
function classify(completedHours, goalHours, thr) {
  const pct = goalHours > 0 ? (completedHours / goalHours) * 100 : 0;
  const level = pct >= thr.epiMinPct ? "EPI" : pct >= thr.mpiMinPct ? "MPI" : "LPI";
  return { pct, level };
}

// Completed Hours per editor for one month: actual tracked timer seconds on
// tasks COMPLETED in the month. budget_used_seconds is the banked total; a task
// taken straight to Done (no Review pause) still has its clock running, so add
// the final segment frozen at completed_at. Admin tasks carry no budget → 0.
// Month boundary matches Goal Setting's Performance actuals exactly (completed_at
// within [month, month+1) in the DB session timezone).
async function completedHoursByEditor(orgId, monthFirst) {
  const { rows } = await pool.query(
    `select t.editor_id as id,
            coalesce(sum(
              t.budget_used_seconds
              + case when t.budget_started_at is not null
                     then greatest(0, extract(epoch from (t.completed_at - t.budget_started_at)))
                     else 0 end
            ), 0) / 3600.0 as hours
       from task t
      where t.org_id = $1
        and t.status = 'done'
        and t.completed_at is not null
        and t.editor_id is not null
        and t.completed_at >= $2
        and t.completed_at < ($2::date + interval '1 month')
      group by t.editor_id`,
    [orgId, monthFirst],
  );
  const m = new Map();
  for (const r of rows) m.set(r.id, Number(r.hours));
  return m;
}

async function upsertSnapshot(orgId, editorId, monthFirst, completedHours, goalHours, level, thr) {
  await pool.query(
    `insert into editor_monthly_performance
       (org_id, editor_id, period_month, completed_hours, monthly_goal_hours,
        performance_level, thresholds_used, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (org_id, editor_id, period_month) do update set
       completed_hours   = excluded.completed_hours,
       monthly_goal_hours = excluded.monthly_goal_hours,
       performance_level = excluded.performance_level,
       thresholds_used   = excluded.thresholds_used,
       computed_at       = now()`,
    [orgId, editorId, monthFirst, completedHours.toFixed(2), goalHours.toFixed(2), level,
     JSON.stringify({ epiMinPct: thr.epiMinPct, mpiMinPct: thr.mpiMinPct })],
  );
}

const round1 = (n) => Math.round(n * 10) / 10;

// GET /management-performance/thresholds — current config + the org's default
// monthly goal hours, so the UI can show resulting hour ranges alongside the %.
managementPerformanceRouter.get("/management-performance/thresholds", requireAdmin, async (req, res, next) => {
  try {
    const thr = await getThresholds(req.orgId);
    const monthFirst = thisMonthFirst();
    const orgCap = await effectiveCapacity(req.orgId, null, monthFirst);
    res.json({ ...thr, orgDefaultGoalHours: capHours(orgCap) });
  } catch (err) { next(err); }
});

const thresholdBody = z.object({
  epiMinPct: z.number().positive().max(200),
  mpiMinPct: z.number().positive().max(200),
});

// PUT /management-performance/thresholds — upsert the single org row.
managementPerformanceRouter.put("/management-performance/thresholds", requireAdmin, async (req, res, next) => {
  try {
    const parsed = thresholdBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid thresholds." });
    const { epiMinPct, mpiMinPct } = parsed.data;
    if (mpiMinPct > epiMinPct) {
      return res.status(400).json({ error: "MPI minimum can't be higher than EPI minimum." });
    }
    await pool.query(
      `insert into performance_threshold (org_id, epi_min_pct, mpi_min_pct, updated_by, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (org_id) do update set
         epi_min_pct = excluded.epi_min_pct,
         mpi_min_pct = excluded.mpi_min_pct,
         updated_by  = excluded.updated_by,
         updated_at  = now()`,
      [req.orgId, epiMinPct, mpiMinPct, req.user.sub],
    );
    res.json({ epiMinPct, mpiMinPct, isDefault: false });
  } catch (err) { next(err); }
});

// GET /management-performance/months — months (YYYY-MM, desc) with any data:
// past snapshots, or any completed task. Current month is always included.
managementPerformanceRouter.get("/management-performance/months", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select distinct m from (
         select to_char(period_month, 'YYYY-MM') m
           from editor_monthly_performance where org_id = $1
         union
         select to_char(date_trunc('month', completed_at), 'YYYY-MM') m
           from task where org_id = $1 and status = 'done' and completed_at is not null
       ) x
       where m <= to_char(now(), 'YYYY-MM')
       order by m desc`,
      [req.orgId],
    );
    const months = rows.map((r) => r.m);
    const cur = thisMonthFirst().slice(0, 7);
    if (!months.includes(cur)) months.unshift(cur);
    res.json({ months });
  } catch (err) { next(err); }
});

// Active editors for the org (all roles — matches Goal Setting's roster, since
// the goal capacity is per-editor regardless of role).
async function activeEditors(orgId) {
  const { rows } = await pool.query(
    "select id, name, designation, image_url from editor where org_id = $1 and active order by name",
    [orgId],
  );
  return rows;
}

// Build (and snapshot) one editor's month figures. `stored` is the existing
// frozen snapshot row if any; for a past month we keep it as-is, for the current
// month we always recompute against live thresholds.
function buildRow(editor, hoursMap, goalHours, thr) {
  const completedHours = round1(hoursMap.get(editor.id) ?? 0);
  const { pct, level } = classify(completedHours, goalHours, thr);
  return {
    editorId: editor.id,
    name: editor.name,
    designation: editor.designation,
    imageUrl: editor.image_url,
    monthlyGoalHours: round1(goalHours),
    completedHours,
    remainingHours: round1(Math.max(0, goalHours - completedHours)),
    completionPct: round1(pct),
    level,
    thresholdsUsed: { epiMinPct: thr.epiMinPct, mpiMinPct: thr.mpiMinPct },
  };
}

function rowFromStored(editor, s) {
  const goalHours = Number(s.monthly_goal_hours);
  const completedHours = Number(s.completed_hours);
  return {
    editorId: editor.id,
    name: editor.name,
    designation: editor.designation,
    imageUrl: editor.image_url,
    monthlyGoalHours: round1(goalHours),
    completedHours: round1(completedHours),
    remainingHours: round1(Math.max(0, goalHours - completedHours)),
    completionPct: goalHours > 0 ? round1((completedHours / goalHours) * 100) : 0,
    level: s.performance_level,
    thresholdsUsed: s.thresholds_used || {},
  };
}

// GET /management-performance?month=YYYY-MM — one row per active editor.
managementPerformanceRouter.get("/management-performance", requireAdmin, async (req, res, next) => {
  try {
    const monthFirst = await firstOfMonth(req.query.month || thisMonthFirst());
    const isCurrent = monthFirst.slice(0, 7) === thisMonthFirst().slice(0, 7);
    const thr = await getThresholds(req.orgId);
    const [editors, hoursMap, storedRows] = await Promise.all([
      activeEditors(req.orgId),
      completedHoursByEditor(req.orgId, monthFirst),
      pool.query("select * from editor_monthly_performance where org_id = $1 and period_month = $2", [req.orgId, monthFirst]),
    ]);
    const stored = new Map(storedRows.rows.map((s) => [s.editor_id, s]));

    const rows = [];
    for (const e of editors) {
      if (!isCurrent && stored.has(e.id)) {
        // Past month, already snapshotted → frozen, don't recompute.
        rows.push(rowFromStored(e, stored.get(e.id)));
      } else {
        const goalHours = capHours(await effectiveCapacity(req.orgId, e.id, monthFirst));
        const row = buildRow(e, hoursMap, goalHours, thr);
        await upsertSnapshot(req.orgId, e.id, monthFirst, row.completedHours, goalHours, row.level, thr);
        rows.push(row);
      }
    }
    const orgCap = await effectiveCapacity(req.orgId, null, monthFirst);
    res.json({
      month: monthFirst.slice(0, 7),
      isCurrent,
      thresholds: thr,
      orgDefaultGoalHours: capHours(orgCap),
      rows,
    });
  } catch (err) { next(err); }
});

// GET /management-performance/:editorId?month=YYYY-MM — one editor's detail:
// the month's figures + previous months' snapshot history + Start/End EOD
// session history (DISPLAY ONLY — never part of the completed-hours calc).
managementPerformanceRouter.get("/management-performance/:editorId", requireAdmin, async (req, res, next) => {
  try {
    const editorId = req.params.editorId;
    const { rows: erows } = await pool.query(
      "select id, name, designation, image_url from editor where id = $1 and org_id = $2",
      [editorId, req.orgId],
    );
    if (!erows[0]) return res.status(404).json({ error: "Editor not found." });
    const editor = erows[0];

    const monthFirst = await firstOfMonth(req.query.month || thisMonthFirst());
    const isCurrent = monthFirst.slice(0, 7) === thisMonthFirst().slice(0, 7);
    const thr = await getThresholds(req.orgId);

    const { rows: storedRows } = await pool.query(
      "select * from editor_monthly_performance where org_id = $1 and editor_id = $2 and period_month = $3",
      [req.orgId, editorId, monthFirst],
    );

    let current;
    if (!isCurrent && storedRows[0]) {
      current = rowFromStored(editor, storedRows[0]);
    } else {
      const hoursMap = await completedHoursByEditor(req.orgId, monthFirst);
      const goalHours = capHours(await effectiveCapacity(req.orgId, editorId, monthFirst));
      current = buildRow(editor, hoursMap, goalHours, thr);
      await upsertSnapshot(req.orgId, editorId, monthFirst, current.completedHours, goalHours, current.level, thr);
    }

    // Previous months' snapshot history (excluding the month being viewed).
    const { rows: history } = await pool.query(
      `select to_char(period_month, 'YYYY-MM') as month,
              completed_hours::float as "completedHours",
              monthly_goal_hours::float as "monthlyGoalHours",
              performance_level as level, thresholds_used as "thresholdsUsed"
         from editor_monthly_performance
        where org_id = $1 and editor_id = $2 and period_month <> $3
        order by period_month desc
        limit 24`,
      [req.orgId, editorId, monthFirst],
    );

    // EOD session history for the month — supplementary context, labelled
    // distinctly from task-timer hours. eod_session.date is the workday.
    const { rows: eodSessions } = await pool.query(
      `select date::text as date,
              started_at as "startedAt",
              ended_at as "endedAt",
              case when ended_at is not null
                   then round(extract(epoch from (ended_at - started_at)) / 3600.0, 2)
                   else null end as "spanHours"
         from eod_session
        where org_id = $1 and editor_id = $2
          and date >= $3 and date < ($3::date + interval '1 month')
        order by started_at desc`,
      [req.orgId, editorId, monthFirst],
    );

    res.json({
      editor: { id: editor.id, name: editor.name, designation: editor.designation, imageUrl: editor.image_url },
      month: monthFirst.slice(0, 7),
      isCurrent,
      thresholds: thr,
      ...current,
      history,
      eodSessions: eodSessions.map((s) => ({ ...s, spanHours: s.spanHours == null ? null : Number(s.spanHours) })),
    });
  } catch (err) { next(err); }
});
