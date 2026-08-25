-- Break/pause tracking for the time-budget countdown. Office breaks (lunch
-- 45m + two 15m tea breaks = 75m/day) stop an editor's running task timers
-- without needing to touch every individual task: the offset is banked here
-- and added to each task's deadline lazily when it's displayed/checked,
-- so it's correct for however many tasks that editor has running at once,
-- and self-corrects if a browser tab is closed mid-break (see resolveBreak
-- in server/src/routes/breaks.js).
alter table public.editor
  add column break_started_at timestamptz,
  add column break_used_seconds int not null default 0,
  add column break_date date;
