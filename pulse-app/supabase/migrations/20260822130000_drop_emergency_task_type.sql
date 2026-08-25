-- Drop "emergency" from task_type — it overlapped with priority (both meant
-- "urgent"). Priority already has "high" for that; task_type stays a pure
-- category (content / short_task / general).
update public.task
   set task_type = 'short_task', priority = 'high'
 where task_type = 'emergency';

alter table public.task drop constraint if exists task_task_type_check;
alter table public.task
  add constraint task_task_type_check check (task_type in ('content', 'short_task', 'general'));
