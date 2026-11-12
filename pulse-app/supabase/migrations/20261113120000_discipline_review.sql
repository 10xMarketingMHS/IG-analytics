-- Discipline is rated by more than one person (server/src/discipline.js): its
-- 20% of the score is shared — Manager 15% and Team Lead 5%, or, once someone
-- holds the Asst. Manager position, Manager 10%, Asst. Manager 7% and Team Lead
-- 3%. The Manager's stars stay in editor_discipline_points; the Team Lead's and
-- the Asst. Manager's go here, one row per rater, person and month (two Team
-- Leads rating the same person are averaged). A criterion nobody in a role has
-- rated yet counts as full marks. Safe to run more than once.

create table if not exists public.editor_discipline_review (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.org(id) on delete cascade,
  editor_id               uuid not null references public.editor(id) on delete cascade,
  period_month            date not null,
  rater_role              text not null check (rater_role in ('asst_manager', 'lead')),
  rater_user_id           uuid not null references public.app_user(id) on delete cascade,
  punctuality             smallint check (punctuality between 0 and 5),
  quality_responsibility  smallint check (quality_responsibility between 0 and 5),
  behaviour               smallint check (behaviour between 0 and 5),
  attendance_availability smallint check (attendance_availability between 0 and 5),
  deadline_adherence      smallint check (deadline_adherence between 0 and 5),
  note                    text,
  updated_at              timestamptz not null default now(),
  unique (org_id, editor_id, period_month, rater_role, rater_user_id)
);

create index if not exists editor_discipline_review_month_idx on public.editor_discipline_review (org_id, period_month);
