-- Task comments (discussion thread) + task recurrence.
create table if not exists public.task_comment (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.task(id) on delete cascade,
  author_id uuid references public.app_user(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_comment_task_idx on public.task_comment(task_id);

alter table public.task
  add column if not exists recurrence text not null default 'none'
  check (recurrence in ('none','daily','weekly'));
