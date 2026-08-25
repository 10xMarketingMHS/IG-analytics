-- Adds a Review stage between In Progress and Done: the assignee submits
-- their work for review; only an admin can approve it into Done or send it
-- back to In Progress for rework. See server/src/routes/tasks.js for the
-- status-transition permission logic this enables.
alter table public.task drop constraint if exists task_status_check;
alter table public.task
  add constraint task_status_check check (status in ('todo', 'in_progress', 'review', 'done'));
