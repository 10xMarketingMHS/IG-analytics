-- Time-budget pause/resume across a review cycle: entering Review banks
-- whatever's already elapsed and stops the clock; a rework cycle requires
-- the assignee to explicitly re-accept (same gate a fresh assignment gets),
-- carrying that banked time forward so the countdown picks up where it left
-- off instead of resetting to the full budget. pending_note is the rework
-- note surfaced right at that re-accept moment.
alter table public.task
  add column budget_used_seconds numeric not null default 0,
  add column pending_note text;
