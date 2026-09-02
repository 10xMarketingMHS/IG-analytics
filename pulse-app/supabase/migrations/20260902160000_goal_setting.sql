-- Goal Setting: individual monthly capacity planning + performance tracking.
--
-- A capacity/planning layer on top of task_content_format. Fully independent of
-- Task Points / the leaderboard — goals here never feed scoring or rank.
--
-- JPH = "hours required per job" (the same concept as a content type's time
-- budget, task_time_rule.hours). Planned hours = Σ(JC × JPH). The jph is
-- SNAPSHOTTED onto each goal row (like a task's budget at creation) so later
-- edits to a content type's time budget never silently change past months.

-- Monthly capacity: an org-wide default (editor_id NULL) with an optional
-- per-editor override, mirroring task_time_rule's global-default + override
-- shape. Capacity hours = working_days × hours_per_day, computed on read.
create table public.editor_capacity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  editor_id uuid references public.editor(id) on delete cascade,  -- NULL = org-wide default
  period_month date not null,                                     -- first-of-month
  working_days int not null check (working_days >= 0),
  hours_per_day numeric(5,2) not null check (hours_per_day >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One org-wide default per month, and at most one override per editor per month.
create unique index editor_capacity_global_uq
  on public.editor_capacity(org_id, period_month) where editor_id is null;
create unique index editor_capacity_editor_uq
  on public.editor_capacity(org_id, period_month, editor_id) where editor_id is not null;

-- One goal row per editor per content type per month. jc = job-count target,
-- jph = hours per job (snapshotted; pre-filled from the content type's time
-- budget when the admin opens the form).
create table public.editor_goal (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  editor_id uuid not null references public.editor(id) on delete cascade,
  content_format_id uuid not null references public.task_content_format(id) on delete cascade,
  period_month date not null,
  jc int not null check (jc >= 0),
  jph numeric(6,2) not null check (jph >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, editor_id, content_format_id, period_month)
);
create index editor_goal_lookup on public.editor_goal(org_id, editor_id, period_month);
