-- Pulse — Task acceptance.
-- Additive only. When a task is assigned to someone OTHER than whoever did
-- the assigning, it needs an explicit accept before its time-budget timer
-- starts. Self-assigned tasks (or ones with no assignee) are accepted
-- automatically — default true preserves existing behavior for every task
-- already in the table.
alter table public.task
  add column if not exists accepted boolean not null default true;
