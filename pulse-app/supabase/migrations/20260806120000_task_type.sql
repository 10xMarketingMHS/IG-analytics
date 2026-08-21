-- Pulse — Task Type.
-- Additive only. Lets a task exist without being tied to content: auto-created
-- (post-linked) tasks are always 'content'; manual tasks default to 'general'
-- and the user can pick 'short_task' or 'emergency' instead. Distinct from
-- `priority` (low/medium/high, how important) — task_type is *what kind* of
-- work it is, so the two don't collide.

alter table public.task
  add column if not exists task_type text not null default 'general'
  check (task_type in ('content', 'short_task', 'emergency', 'general'));

-- Backfill: existing auto-created tasks (linked to a post) become 'content'.
-- Everything else already defaulted to 'general' above.
update public.task
   set task_type = 'content'
 where post_id is not null
   and task_type = 'general';

create index if not exists task_type_idx on public.task(task_type);
