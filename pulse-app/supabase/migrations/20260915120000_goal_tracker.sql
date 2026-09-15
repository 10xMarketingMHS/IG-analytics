-- Goals — admin-only manual goal-tracking dashboard.
--
-- Distinct from "Goal Setting" (editor_goal): that is per-editor monthly content
-- capacity/JC planning. THIS is an org-level dashboard of manually tracked
-- objectives (revenue, team, project/work, custom) — no automatic wiring to
-- Task Points or Goal Setting. Every number here is entered by an admin.
--
-- The API lives under /goal-tracker (not /goals, which Goal Setting owns).

create table public.goal (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.org(id) on delete cascade,
  created_by    uuid references public.app_user(id) on delete set null,
  type          text not null check (type in ('revenue','overall_team','project_work','custom')),
  title         text not null,
  description   text,
  -- Free-text unit the admin defines (e.g. "₹", "tasks", "%") — what target/
  -- current values are counted in.
  unit_label    text,
  target_value  numeric not null default 0,
  -- Cached latest value == the most recent goal_progress_update.value. Kept in
  -- sync in the same transaction as every progress insert; never edited on its
  -- own.
  current_value numeric not null default 0,
  -- Optional scope to one brand/channel; null = org-wide.
  channel_id    uuid references public.workspace(id) on delete set null,
  deadline      date,
  created_at    timestamptz not null default now()
);
create index goal_org_idx on public.goal(org_id);

-- Progress history — one row per manual update. This is what makes
-- "progress over time" (the detail chart) and historical data possible from
-- manual entries. The goal's cached current_value always mirrors the newest row.
create table public.goal_progress_update (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references public.goal(id) on delete cascade,
  value      numeric not null,
  note       text,
  updated_by uuid references public.app_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index goal_progress_update_goal_idx on public.goal_progress_update(goal_id, updated_at);
