-- Admin "Hold": an in-progress task an admin has parked.
--
-- Hold is NOT a new status/column — the task stays In Progress. It's a flag
-- that shows a "Hold" badge and PAUSES the time-budget countdown (same bank/
-- resume mechanics as the Review pause: banking elapsed seconds into
-- budget_used_seconds and clearing budget_started_at, then restoring the start
-- from what was banked on resume). Only an admin can hold or resume a task.
alter table public.task
  add column if not exists on_hold boolean not null default false;
