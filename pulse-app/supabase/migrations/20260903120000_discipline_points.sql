-- Admin Discipline Points: the 20% admin-controlled half of an editor's monthly
-- Overall Score (the other 80% is the editor's completion-based Earned Points).
--
-- Editor + month scoped (NOT per content type — this does not belong on
-- editor_goal). `points` is NULLABLE: null = "not yet reviewed", treated as the
-- full 20% ceiling for calculation. The ceiling (0.2 × Total Goal Points) is
-- derived live, never snapshotted — Total Goal Points is itself derived from
-- editor_goal × task_content_format.points.
create table public.editor_discipline_points (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  editor_id uuid not null references public.editor(id) on delete cascade,
  period_month date not null,                       -- first-of-month (matches editor_goal)
  points numeric(8,2),                              -- null = not reviewed → full ceiling
  note text,
  updated_by uuid references public.app_user(id),   -- null until first set
  updated_at timestamptz,                           -- null until first set
  unique (org_id, editor_id, period_month)
);
