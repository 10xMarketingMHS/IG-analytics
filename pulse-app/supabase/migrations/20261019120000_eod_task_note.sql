-- End of Day notes: what an employee did on each of the day's tasks, written in
-- the End of Day window and carried into the day's report. One note per task
-- per person per day; removing a task removes its notes.
create table if not exists public.eod_task_note (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.org(id) on delete cascade,
  editor_id  uuid not null references public.editor(id) on delete cascade,
  date       date not null,
  task_id    uuid not null references public.task(id) on delete cascade,
  note       text not null,
  updated_at timestamptz not null default now(),
  unique (editor_id, date, task_id)
);

create index if not exists eod_task_note_org_date_idx on public.eod_task_note(org_id, date);
