-- Sending a task back from Review to In Progress now requires a note (what
-- needs fixing) and bumps the task's revision — a small audit trail of every
-- review decision (sent back or approved), not just the latest note.
alter table public.task add column revision int not null default 1;

create table public.task_review_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.task(id) on delete cascade,
  revision int not null,
  action text not null check (action in ('approved', 'sent_back')),
  note text,
  actor_id uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index task_review_log_task_idx on public.task_review_log(task_id, created_at desc);
