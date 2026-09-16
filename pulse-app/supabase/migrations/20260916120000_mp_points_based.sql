-- Management Performance, points-based (supersedes the hours-based version).
--
-- The performance measure is now Overall Performance % — the SAME Earned (80%) +
-- Discipline (20%) split of Total Goal Points that Goal Setting's Performance tab
-- and My Day already use (see goal-points.ts's goalBreakdown) — banded EPI/MPI/LPI
-- by percentage thresholds. Nothing here is hours-denominated any more.
--
--   Total Goal Points = Σ (Goal JC × content type's points)
--   Earned Points     = 80% × Σ[ min(1, actualJC/goalJC) × goalJC × points ]
--   Potential Points  = 80% × Total Goal Points   (Earned ceiling — reference only)
--   Discipline Points = (Σ 5 criterion ratings ÷ 25) × (20% × Total Goal Points)
--   Total Points      = Earned + Discipline        (NOT + Potential)
--   Overall Perf %    = Total Points ÷ Total Goal Points × 100
--   EPI ≥ epi_min_pct · MPI in [mpi_min_pct, epi_min_pct) · LPI below
-- Total Goal Points = 0 → no goals → no level (null), not a 0% score.

-- All existing rows are dummy from initial development (confirmed with the user)
-- — discard them; the board recomputes live and snapshots fresh going forward.
delete from public.editor_monthly_performance;

alter table public.editor_monthly_performance
  drop column if exists completed_hours,
  drop column if exists monthly_goal_hours,
  drop column if exists task_goal,
  drop column if exists task_achieved,
  add column if not exists total_goal_points     numeric(10,2) not null default 0,
  add column if not exists earned_points          numeric(10,2) not null default 0,
  add column if not exists potential_points        numeric(10,2) not null default 0,
  add column if not exists discipline_points       numeric(10,2) not null default 0,
  add column if not exists total_points            numeric(10,2) not null default 0,
  add column if not exists goal_target_number      int not null default 0,
  add column if not exists achieved_number         int not null default 0,
  add column if not exists performance_percentage  numeric(6,2);

-- A month with no goals has no band, so the level is now nullable.
alter table public.editor_monthly_performance alter column performance_level drop not null;

-- Thresholds now apply to Overall Performance %; new defaults per the spec (85/75).
-- The single existing row held stale hours-era values, so reset it too.
alter table public.performance_threshold alter column epi_min_pct set default 85;
alter table public.performance_threshold alter column mpi_min_pct set default 75;
update public.performance_threshold set epi_min_pct = 85, mpi_min_pct = 75;
