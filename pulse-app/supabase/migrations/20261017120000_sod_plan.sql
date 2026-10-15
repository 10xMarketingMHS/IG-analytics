-- Start of Day (SOD): once each morning, after the first Start Work, an employee
-- sends their plan for the day. Kept as it was sent — `tasks` is a snapshot
-- (id, title, type, due date, why it's on the list) — so the morning plan still
-- reads the same at End of Day, even if a task is renamed or removed later.
create table if not exists public.sod_plan (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.org(id) on delete cascade,
  editor_id    uuid not null references public.editor(id) on delete cascade,
  date         date not null,
  submitted_at timestamptz not null default now(),
  note         text,
  tasks        jsonb not null default '[]'::jsonb,
  unique (editor_id, date)
);

create index if not exists sod_plan_org_date_idx on public.sod_plan(org_id, date);
