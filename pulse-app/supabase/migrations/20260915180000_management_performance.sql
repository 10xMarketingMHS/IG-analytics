-- Management Performance (EPI / MPI / LPI): monthly "completed hours" vs each
-- editor's own monthly goal capacity, banded into performance levels.
--
-- Completed hours = actual tracked timer time (task.budget_used_seconds, plus
-- the final still-running segment frozen at completed_at) summed over the
-- editor's tasks COMPLETED that month. Admin-category tasks carry no timer, so
-- they add nothing (by that feature's own design). This is deliberately NOT EOD
-- session duration and NOT Goal Setting's synthetic Actual Hours (Actual JC ×
-- JPH — an estimate, not real tracked time).
--
-- Thresholds are stored as PERCENTAGES of each editor's OWN monthly goal
-- (reusing Goal Setting's editor_capacity: global default + per-editor
-- override), so a per-editor capacity override still lands in the right band —
-- a fixed hour count would be unreachable for anyone whose personal goal isn't
-- the org default. Defaults reproduce the user's 192hr example exactly:
--   EPI ≥ 93.75% (180 of 192), MPI 83.3%–93.74% (160 of 192), LPI below 83.3%.

-- Single active row per org — org-wide configuration, not per-editor.
create table if not exists public.performance_threshold (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  epi_min_pct numeric(6,3) not null default 93.75 check (epi_min_pct > 0 and epi_min_pct <= 200),
  mpi_min_pct numeric(6,3) not null default 83.3  check (mpi_min_pct > 0 and mpi_min_pct <= 200),
  updated_by uuid references public.app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (mpi_min_pct <= epi_min_pct)
);
create unique index if not exists performance_threshold_org_uq
  on public.performance_threshold(org_id);

-- Monthly snapshot — one row per editor per month. A past month's numbers are
-- frozen here (thresholds_used stores the % actually applied) so a later
-- threshold edit never rewrites history. The current, in-progress month is
-- recomputed and re-snapshotted whenever it's queried.
create table if not exists public.editor_monthly_performance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  editor_id uuid not null references public.editor(id) on delete cascade,
  period_month date not null,                          -- first-of-month
  completed_hours numeric(8,2) not null default 0,
  monthly_goal_hours numeric(8,2) not null default 0,  -- capacity actually in effect that month
  performance_level text not null check (performance_level in ('EPI', 'MPI', 'LPI')),
  thresholds_used jsonb not null default '{}'::jsonb,  -- { epiMinPct, mpiMinPct }
  computed_at timestamptz not null default now(),
  unique (org_id, editor_id, period_month)
);
create index if not exists editor_monthly_performance_lookup
  on public.editor_monthly_performance(org_id, period_month);
