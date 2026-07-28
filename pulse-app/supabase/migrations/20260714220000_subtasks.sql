-- Checklist items (subtasks) for a task.
create table if not exists public.subtask (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.task(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists subtask_task_idx on public.subtask(task_id);
