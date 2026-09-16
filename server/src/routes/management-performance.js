import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

// Management Performance (points-based). Admin-only board + config; a self view
// for My Day. The performance measure is Overall Performance % — the Earned
// (80%) + Discipline (20%) split of Total Goal Points that Goal Setting's
// Performance tab and My Day already use — banded EPI/MPI/LPI by % thresholds.
//
// IMPORTANT: computeScore() below MUST stay in lockstep with the frontend's
// goalBreakdown() in pulse-app/src/lib/goal-points.ts. That is the canonical
// 80/20 implementation; the server and app are separate packages and cannot
// share the module, so this is a deliberate mirror — change both together.
export const managementPerformanceRouter = Router();

const DEFAULT_THRESHOLDS = { epiMinPct: 85, mpiMinPct: 75 };

// The 5 Admin Discipline criteria (columns on editor_discipline_points); a null
// rating counts as the full 5 until an admin reviews it. Mirrors goals.js.
const CRITERIA = ["punctuality", "quality_responsibility", "behaviour", "attendance_availability", "deadline_adherence"];
const MAX_RATING_SUM = CRITERIA.length * 5; // 25

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function thisMonthFirst() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// First-of-month as 'YYYY-MM-DD' — pure string math, no DB round-trip.
function firstOfMonth(monthIn) {
  const [y, m] = String(monthIn).slice(0, 10).split("-");
  return `${y}-${String(Number(m)).padStart(2, "0")}-01`;
}

async function getThresholds(orgId) {
  const { rows } = await pool.query(
    "select epi_min_pct, mpi_min_pct from performance_threshold where org_id = $1",
    [orgId],
  );
  if (!rows[0]) return { ...DEFAULT_THRESHOLDS, isDefault: true };
  return { epiMinPct: Number(rows[0].epi_min_pct), mpiMinPct: Number(rows[0].mpi_min_pct), isDefault: false };
}

// EPI/MPI/LPI from Overall Performance %. Null when there's no % (no goals).
function classify(pct, thr) {
  if (pct == null) return null;
  return pct >= thr.epiMinPct ? "EPI" : pct >= thr.mpiMinPct ? "MPI" : "LPI";
}

// Mirror of goal-points.ts goalBreakdown(). `rows`: [{ goalJC, actualJC, points }];
// `ratings`: object keyed by the 5 CRITERIA (null = unreviewed → full 5).
// Returns null when Total Goal Points is 0 (no goals — no score to band).
function computeScore(rows, ratings) {
  const total = rows.reduce((s, r) => s + (r.goalJC ?? 0) * (r.points ?? 0), 0);
  if (total <= 0) return null;
  const earned = 0.8 * rows.reduce((s, r) => {
    const comp = r.goalJC > 0 ? Math.min(1, r.actualJC / r.goalJC) : 0;
    return s + comp * r.goalJC * r.points;
  }, 0);
  const potential = 0.8 * total;               // Earned ceiling — reference, not summed
  const ceiling = 0.2 * total;                 // Discipline bucket ceiling
  const ratingSum = CRITERIA.reduce((s, k) => s + (ratings?.[k] ?? 5), 0);
  const reviewed = CRITERIA.every((k) => ratings?.[k] != null);
  const discipline = (ratingSum / MAX_RATING_SUM) * ceiling;
  const totalPoints = earned + discipline;
  const goalTarget = rows.reduce((s, r) => s + (r.goalJC ?? 0), 0);
  const achieved = rows.reduce((s, r) => s + (r.actualJC ?? 0), 0);
  return {
    total, earned, potential, discipline, totalPoints, reviewed,
    goalTarget, achieved,
    pct: total > 0 ? (totalPoints / total) * 100 : 0,
  };
}

// ---- Per-editor data for the board — SEPARATE simple queries, run in parallel.
// Counter-intuitively this beats one big combined query here: the remote session
// pooler answers a warm simple query in ~370ms but runs a big multi-CTE query
// erratically (1–6s). With the whole pool kept warm (see db.js), 5 simple queries
// in parallel land on 5 warm connections and finish together (~370ms). ----
async function goalRowsByEditor(orgId, monthFirst) {
  const { rows } = await pool.query(
    `select g.editor_id, g.content_format_id, g.jc, cf.points
       from editor_goal g join task_content_format cf on cf.id = g.content_format_id
      where g.org_id = $1 and g.period_month = $2`,
    [orgId, monthFirst],
  );
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.editor_id)) m.set(r.editor_id, []);
    m.get(r.editor_id).push({ contentFormatId: r.content_format_id, goalJC: Number(r.jc), points: Number(r.points) });
  }
  return m;
}

async function actualsByEditorFormat(orgId, monthFirst) {
  const { rows } = await pool.query(
    `select editor_id, content_format_id, count(*)::int n
       from task
      where org_id = $1 and status = 'done' and content_format_id is not null
        and completed_at >= $2 and completed_at < ($2::date + interval '1 month')
      group by editor_id, content_format_id`,
    [orgId, monthFirst],
  );
  const m = new Map();
  for (const r of rows) m.set(`${r.editor_id}:${r.content_format_id}`, Number(r.n));
  return m;
}

async function ratingsByEditor(orgId, monthFirst) {
  const { rows } = await pool.query(
    `select editor_id, ${CRITERIA.join(", ")} from editor_discipline_points where org_id = $1 and period_month = $2`,
    [orgId, monthFirst],
  );
  const m = new Map();
  for (const r of rows) m.set(r.editor_id, Object.fromEntries(CRITERIA.map((k) => [k, r[k] == null ? null : Number(r[k])])));
  return m;
}

// Active, non-admin editors + the org thresholds (folded in via cross join so
// the board is 4 parallel queries, not 5 — keeping it within the warm pool so no
// query cold-connects). admins are hidden from this table.
async function activeEditorsWithThresholds(orgId) {
  const { rows } = await pool.query(
    `with thr as (
        select coalesce(max(epi_min_pct), ${DEFAULT_THRESHOLDS.epiMinPct}) epi,
               coalesce(max(mpi_min_pct), ${DEFAULT_THRESHOLDS.mpiMinPct}) mpi,
               count(*) > 0 as has
          from performance_threshold where org_id = $1
     )
     select e.id, e.name, e.designation, e.image_url, thr.epi::float epi, thr.mpi::float mpi, thr.has
       from editor e cross join thr
      where e.org_id = $1 and e.active
        and not exists (select 1 from app_user u join membership m on m.user_id = u.id
                         where u.editor_id = e.id and m.role = 'admin')
      order by e.name`,
    [orgId],
  );
  const thr = rows[0]
    ? { epiMinPct: Number(rows[0].epi), mpiMinPct: Number(rows[0].mpi), isDefault: !rows[0].has }
    : { ...DEFAULT_THRESHOLDS, isDefault: true };
  return { editors: rows, thr };
}

// Build one editor's computeScore() input rows from the shared maps.
function rowsFor(editorId, goalMap, actualsMap) {
  return (goalMap.get(editorId) ?? []).map((g) => ({
    goalJC: g.goalJC, points: g.points,
    actualJC: actualsMap.get(`${editorId}:${g.contentFormatId}`) ?? 0,
  }));
}

// Assemble one editor's board/detail row from a computed score (or null).
function scoreToRow(editor, score, thr) {
  if (!score) {
    return {
      editorId: editor.id, name: editor.name, designation: editor.designation, imageUrl: editor.image_url,
      hasGoal: false, totalGoalPoints: 0, earnedPoints: 0, potentialPoints: 0, disciplinePoints: 0,
      totalPoints: 0, goalTargetNumber: 0, achievedNumber: 0, performancePct: null, level: null,
      reviewed: false, thresholdsUsed: { epiMinPct: thr.epiMinPct, mpiMinPct: thr.mpiMinPct },
    };
  }
  const pct = round1(score.pct);
  return {
    editorId: editor.id, name: editor.name, designation: editor.designation, imageUrl: editor.image_url,
    hasGoal: true,
    totalGoalPoints: round2(score.total),
    earnedPoints: round2(score.earned),
    potentialPoints: round2(score.potential),
    disciplinePoints: round2(score.discipline),
    totalPoints: round2(score.totalPoints),
    goalTargetNumber: score.goalTarget,
    achievedNumber: score.achieved,
    performancePct: pct,
    level: classify(pct, thr),
    reviewed: score.reviewed,
    thresholdsUsed: { epiMinPct: thr.epiMinPct, mpiMinPct: thr.mpiMinPct },
  };
}

function rowFromStored(editor, s) {
  const total = Number(s.total_goal_points);
  return {
    editorId: editor.id, name: editor.name, designation: editor.designation, imageUrl: editor.image_url,
    hasGoal: total > 0,
    totalGoalPoints: round2(total),
    earnedPoints: round2(Number(s.earned_points)),
    potentialPoints: round2(Number(s.potential_points)),
    disciplinePoints: round2(Number(s.discipline_points)),
    totalPoints: round2(Number(s.total_points)),
    goalTargetNumber: Number(s.goal_target_number),
    achievedNumber: Number(s.achieved_number),
    performancePct: s.performance_percentage == null ? null : Number(s.performance_percentage),
    level: s.performance_level ?? null,
    reviewed: true,
    thresholdsUsed: s.thresholds_used || {},
  };
}

// Persist a whole month's freshly-computed rows in ONE multi-row upsert (instead
// of N sequential writes). Callers fire this in the background — the snapshot
// only freezes past months, so the response never needs to wait on the write.
async function batchUpsertSnapshots(orgId, monthFirst, rows, thr) {
  if (!rows.length) return;
  const thrJson = JSON.stringify({ epiMinPct: thr.epiMinPct, mpiMinPct: thr.mpiMinPct });
  const N = 13; // columns per row (computed_at is now())
  const vals = [];
  const tuples = rows.map((row, i) => {
    const b = i * N;
    vals.push(orgId, row.editorId, monthFirst, row.totalGoalPoints, row.earnedPoints, row.potentialPoints,
      row.disciplinePoints, row.totalPoints, row.goalTargetNumber, row.achievedNumber,
      row.performancePct, row.level, thrJson);
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13}, now())`;
  });
  await pool.query(
    `insert into editor_monthly_performance
       (org_id, editor_id, period_month, total_goal_points, earned_points, potential_points,
        discipline_points, total_points, goal_target_number, achieved_number,
        performance_percentage, performance_level, thresholds_used, computed_at)
     values ${tuples.join(", ")}
     on conflict (org_id, editor_id, period_month) do update set
       total_goal_points = excluded.total_goal_points,
       earned_points = excluded.earned_points,
       potential_points = excluded.potential_points,
       discipline_points = excluded.discipline_points,
       total_points = excluded.total_points,
       goal_target_number = excluded.goal_target_number,
       achieved_number = excluded.achieved_number,
       performance_percentage = excluded.performance_percentage,
       performance_level = excluded.performance_level,
       thresholds_used = excluded.thresholds_used,
       computed_at = now()`,
    vals,
  );
}

const bgSnapshot = (orgId, monthFirst, rows, thr) =>
  batchUpsertSnapshots(orgId, monthFirst, rows, thr).catch((e) => console.error("MP snapshot upsert failed:", e.message));

// One editor's goal-format rows ({goalJC, actualJC, points}) + discipline ratings
// for the month — the minimal data computeScore needs, without pulling the whole
// org (used by the /me self view).
async function scoreForEditor(orgId, editorId, monthFirst) {
  const [goalRes, ratingRes] = await Promise.all([
    pool.query(
      `with g as (
          select content_format_id id, sum(jc)::int jc
            from editor_goal where org_id=$1 and editor_id=$2 and period_month=$3 group by content_format_id
        ), a as (
          select content_format_id id, count(*)::int n
            from task where org_id=$1 and editor_id=$2 and status='done' and content_format_id is not null
              and completed_at>=$3 and completed_at<($3::date + interval '1 month') group by content_format_id
        )
        select cf.points, g.jc as goal, coalesce(a.n,0) as achieved
          from g join task_content_format cf on cf.id = g.id
          left join a on a.id = g.id`,
      [orgId, editorId, monthFirst],
    ),
    pool.query(`select ${CRITERIA.join(", ")} from editor_discipline_points where org_id=$1 and editor_id=$2 and period_month=$3`, [orgId, editorId, monthFirst]),
  ]);
  const rows = goalRes.rows.map((r) => ({ goalJC: Number(r.goal), actualJC: Number(r.achieved), points: Number(r.points) }));
  const rr = ratingRes.rows[0];
  const ratings = rr ? Object.fromEntries(CRITERIA.map((k) => [k, rr[k] == null ? null : Number(rr[k])])) : null;
  return computeScore(rows, ratings);
}

// ---------------------------------------------------------------------------
// Thresholds config
// ---------------------------------------------------------------------------
managementPerformanceRouter.get("/management-performance/thresholds", requireAdmin, async (req, res, next) => {
  try {
    res.json(await getThresholds(req.orgId));
  } catch (err) { next(err); }
});

const thresholdBody = z.object({
  epiMinPct: z.number().positive().max(100),
  mpiMinPct: z.number().positive().max(100),
});

managementPerformanceRouter.put("/management-performance/thresholds", requireAdmin, async (req, res, next) => {
  try {
    const parsed = thresholdBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid thresholds." });
    const { epiMinPct, mpiMinPct } = parsed.data;
    if (mpiMinPct > epiMinPct) return res.status(400).json({ error: "MPI minimum can't be higher than EPI minimum." });
    await pool.query(
      `insert into performance_threshold (org_id, epi_min_pct, mpi_min_pct, updated_by, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (org_id) do update set
         epi_min_pct = excluded.epi_min_pct, mpi_min_pct = excluded.mpi_min_pct,
         updated_by = excluded.updated_by, updated_at = now()`,
      [req.orgId, epiMinPct, mpiMinPct, req.user.sub],
    );
    res.json({ epiMinPct, mpiMinPct, isDefault: false });
  } catch (err) { next(err); }
});

// Months with any data (past snapshots or any completed task); current always included.
managementPerformanceRouter.get("/management-performance/months", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select distinct m from (
         select to_char(period_month, 'YYYY-MM') m from editor_monthly_performance where org_id = $1
         union
         select to_char(period_month, 'YYYY-MM') m from editor_goal where org_id = $1
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

// ---------------------------------------------------------------------------
// Board list — one row per active editor for a month.
// ---------------------------------------------------------------------------
managementPerformanceRouter.get("/management-performance", requireAdmin, async (req, res, next) => {
  try {
    const monthFirst = firstOfMonth(req.query.month || thisMonthFirst());
    const isCurrent = monthFirst.slice(0, 7) === thisMonthFirst().slice(0, 7);

    // Four simple queries in parallel on the warm pool (thresholds folded into
    // the editors query). The stored snapshot is only needed to freeze PAST
    // months, so the current-month hot path skips it — keeping it at 4 queries so
    // none has to cold-connect beyond the warm pool.
    const [edThr, goalMap, actualsMap, ratingMap, storedRows] = await Promise.all([
      activeEditorsWithThresholds(req.orgId),
      goalRowsByEditor(req.orgId, monthFirst),
      actualsByEditorFormat(req.orgId, monthFirst),
      ratingsByEditor(req.orgId, monthFirst),
      isCurrent
        ? Promise.resolve({ rows: [] })
        : pool.query("select * from editor_monthly_performance where org_id = $1 and period_month = $2", [req.orgId, monthFirst]),
    ]);
    const { editors, thr } = edThr;
    const stored = new Map(storedRows.rows.map((s) => [s.editor_id, s]));

    const rows = [];
    const toSnapshot = [];
    for (const e of editors) {
      if (!isCurrent && stored.has(e.id)) {
        rows.push(rowFromStored(e, stored.get(e.id)));
      } else {
        const row = scoreToRow(e, computeScore(rowsFor(e.id, goalMap, actualsMap), ratingMap.get(e.id)), thr);
        rows.push(row);
        if (!isCurrent) toSnapshot.push(row); // freeze past months only
      }
    }
    res.json({ month: monthFirst.slice(0, 7), isCurrent, thresholds: thr, rows });
    if (toSnapshot.length) bgSnapshot(req.orgId, monthFirst, toSnapshot, thr);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Self view (My Day) — the caller's own current-month figures. No admin role.
// ---------------------------------------------------------------------------
managementPerformanceRouter.get("/management-performance/me", async (req, res, next) => {
  try {
    const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
    const eid = rows[0]?.editor_id;
    if (!eid) return res.json({ linked: false });
    const monthFirst = thisMonthFirst();
    const [thr, score] = await Promise.all([
      getThresholds(req.orgId),
      scoreForEditor(req.orgId, eid, monthFirst),
    ]);
    if (!score) {
      return res.json({ linked: true, hasGoal: false, month: monthFirst.slice(0, 7), goalTargetNumber: 0, achievedNumber: 0 });
    }
    res.json({
      linked: true, hasGoal: true, month: monthFirst.slice(0, 7),
      goalTargetNumber: score.goalTarget,
      achievedNumber: score.achieved,
      totalPoints: round2(score.totalPoints),
      totalGoalPoints: round2(score.total),
      performancePct: round1(score.pct),
      level: classify(round1(score.pct), thr),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Individual detail — one editor, one month.
// ---------------------------------------------------------------------------
managementPerformanceRouter.get("/management-performance/:editorId", requireAdmin, async (req, res, next) => {
  try {
    const editorId = req.params.editorId;
    const { rows: erows } = await pool.query(
      "select id, name, designation, image_url from editor where id = $1 and org_id = $2",
      [editorId, req.orgId],
    );
    if (!erows[0]) return res.status(404).json({ error: "Editor not found." });
    const editor = erows[0];

    const monthFirst = firstOfMonth(req.query.month || thisMonthFirst());
    const isCurrent = monthFirst.slice(0, 7) === thisMonthFirst().slice(0, 7);
    const P = [req.orgId, editorId, monthFirst];

    // The detail in as few round-trips as the pooler allows (it serializes
    // concurrent queries). Thresholds are folded into the breakdown query; the
    // stored snapshot is only read for past (frozen) months.
    const [storedRes, breakdownRes, ratingRes, historyRes, eodRes] = await Promise.all([
      isCurrent
        ? Promise.resolve({ rows: [] })
        : pool.query("select * from editor_monthly_performance where org_id = $1 and editor_id = $2 and period_month = $3", P),
      pool.query(
        `with thr as (
            select coalesce(max(epi_min_pct), ${DEFAULT_THRESHOLDS.epiMinPct}) epi,
                   coalesce(max(mpi_min_pct), ${DEFAULT_THRESHOLDS.mpiMinPct}) mpi,
                   count(*) > 0 as has
              from performance_threshold where org_id = $1
          ), g as (
            select content_format_id id, sum(jc)::int jc
              from editor_goal where org_id = $1 and editor_id = $2 and period_month = $3
              group by content_format_id
          ), a as (
            select content_format_id id, count(*)::int n
              from task where org_id = $1 and editor_id = $2 and status = 'done'
                and content_format_id is not null
                and completed_at >= $3 and completed_at < ($3::date + interval '1 month')
              group by content_format_id
          )
          select cf.id, cf.name, cf.icon, cf.category, cf.metric_tier, cf.points,
                 coalesce(g.jc, 0) as goal, coalesce(a.n, 0) as achieved,
                 thr.epi::float epi, thr.mpi::float mpi, thr.has
            from task_content_format cf
            left join g on g.id = cf.id
            left join a on a.id = cf.id
            cross join thr
           where cf.id in (select id from g union select id from a)
           order by cf.category nulls last, cf.sort_order, cf.name`, P),
      pool.query(`select ${CRITERIA.join(", ")} from editor_discipline_points where org_id = $1 and editor_id = $2 and period_month = $3`, P),
      pool.query(
        `select to_char(period_month, 'YYYY-MM') as month,
                total_goal_points::float as "totalGoalPoints",
                total_points::float as "totalPoints",
                performance_percentage::float as "performancePct",
                performance_level as level, thresholds_used as "thresholdsUsed"
           from editor_monthly_performance
          where org_id = $1 and editor_id = $2 and period_month <> $3
          order by period_month desc limit 24`, P),
      pool.query(
        `select date::text as date, started_at as "startedAt", ended_at as "endedAt",
                case when ended_at is not null
                     then round(extract(epoch from (ended_at - started_at)) / 3600.0, 2)
                     else null end as "spanHours"
           from eod_session
          where org_id = $1 and editor_id = $2
            and date >= $3 and date < ($3::date + interval '1 month')
          order by started_at desc`, P),
    ]);
    const breakdown = breakdownRes.rows;
    const history = historyRes.rows;
    const eodSessions = eodRes.rows;
    const thr = breakdown[0]
      ? { epiMinPct: Number(breakdown[0].epi), mpiMinPct: Number(breakdown[0].mpi), isDefault: !breakdown[0].has }
      : await getThresholds(req.orgId);

    let current;
    if (!isCurrent && storedRes.rows[0]) {
      current = rowFromStored(editor, storedRes.rows[0]);
    } else {
      // Score inputs come straight from the breakdown (goal formats only) — no
      // extra queries. Same numbers the board produces for this editor.
      const scoreRows = breakdown.filter((b) => Number(b.goal) > 0)
        .map((b) => ({ goalJC: Number(b.goal), actualJC: Number(b.achieved), points: Number(b.points) }));
      const rr = ratingRes.rows[0];
      const ratings = rr ? Object.fromEntries(CRITERIA.map((k) => [k, rr[k] == null ? null : Number(rr[k])])) : null;
      current = scoreToRow(editor, computeScore(scoreRows, ratings), thr);
      if (!isCurrent) bgSnapshot(req.orgId, monthFirst, [current], thr); // freeze past months only
    }

    res.json({
      editor: { id: editor.id, name: editor.name, designation: editor.designation, imageUrl: editor.image_url },
      month: monthFirst.slice(0, 7),
      isCurrent,
      thresholds: thr,
      ...current,
      taskBreakdown: breakdown.map((b) => ({
        contentFormatId: b.id, name: b.name, icon: b.icon, category: b.category,
        metricTier: b.metric_tier, points: Number(b.points), goal: Number(b.goal), achieved: Number(b.achieved),
      })),
      history,
      eodSessions: eodSessions.map((s) => ({ ...s, spanHours: s.spanHours == null ? null : Number(s.spanHours) })),
    });
  } catch (err) { next(err); }
});
