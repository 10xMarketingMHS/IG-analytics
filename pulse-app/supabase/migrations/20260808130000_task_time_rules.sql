-- Pulse — Task Time Rules (Phase 1 of time-budget tracking).
-- Additive only. Admins set how many hours a piece of work "should" take, per
-- content format (video/image/shoot/other) — either an org-wide default or a
-- specific override for one editor. Editors cannot change their own budget.
--
-- Resolution order for a given (org, editor, format): the editor's own row
-- wins if one exists, otherwise the org's global row (editor_id is null),
-- otherwise there's no budget and the task just has no timer.

create table if not exists public.task_time_rule (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  content_format text not null check (content_format in ('video', 'image', 'shoot', 'other')),
  editor_id uuid references public.editor(id) on delete cascade, -- null = org-wide default
  hours numeric(5,2) not null check (hours > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One global default per format per org...
create unique index if not exists task_time_rule_global_uq
  on public.task_time_rule(org_id, content_format)
  where editor_id is null;
-- ...and at most one override per editor per format.
create unique index if not exists task_time_rule_editor_uq
  on public.task_time_rule(org_id, content_format, editor_id)
  where editor_id is not null;

-- A task's budget is snapshotted onto the task itself when its content_format
-- is set (creation or edit) — later rule changes don't retroactively alter a
-- budget already running. budget_started_at is when that snapshot happened,
-- i.e. when the countdown began.
alter table public.task
  add column if not exists budget_hours numeric(5,2),
  add column if not exists budget_started_at timestamptz;
