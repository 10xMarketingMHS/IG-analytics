-- Admin tasks: an admin-only, lightweight personal task category.
--
-- No project, no content format, no timer/budget, self-assigned, starts In
-- Progress (the one deviation from "every new task starts in To Do"), and fully
-- excluded from all scoring/leaderboards. Additive — just widen the task_type
-- CHECK to allow 'admin'. content_format_id / sid / ad_id are already nullable,
-- so nothing else needs a schema change.
alter table public.task drop constraint if exists task_task_type_check;
alter table public.task
  add constraint task_task_type_check
  check (task_type in ('content', 'short_task', 'general', 'social', 'ad', 'admin'));
