-- Does scheduling a task of this Social type count as one Schedule job for
-- whoever scheduled it (Settings › Tasks & time › Scheduling)? Empty, the
-- default: it follows Next step, so every type that goes to Scheduling counts,
-- as before. Yes or no once someone sets it (Trailer off, say). It counts only
-- while "Each Social task scheduled counts as a Schedule job" is on
-- (server/src/routes/scheduling.js). Safe to run more than once.

alter table public.task_content_format add column if not exists schedule_job boolean;
