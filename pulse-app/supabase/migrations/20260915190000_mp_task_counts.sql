-- Management Performance: also track total Task Goal vs Achieved (job counts),
-- alongside the hours-based EPI/MPI/LPI. Supplementary — the performance band
-- stays hours-only; these are shown as extra context in the detail view.
--   task_goal     = Σ editor_goal.jc for the month (planned jobs, from Goal Setting)
--   task_achieved = completed tasks with a content format in the month (admin
--                   tasks carry no format, so they're excluded — same universe as
--                   Goal Setting's "actual" counts)
-- Snapshotted per month for the same reason the hours are: a closed month's
-- numbers shouldn't shift when goals or tasks change later.
alter table public.editor_monthly_performance
  add column if not exists task_goal int not null default 0,
  add column if not exists task_achieved int not null default 0;
