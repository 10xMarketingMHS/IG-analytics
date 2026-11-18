-- Which schedule type scheduling a Social type's work counts as (Settings ›
-- Tasks & time › Scheduling › Counts as): Reels → Reels schedule, Story → Story
-- schedule, so each kind has its own goal, points and time. Empty: the Schedule
-- type itself, as before. Whether it counts at all is schedule_job
-- (20261118120000_type_schedule_job). Safe to run more than once.

alter table public.task_content_format add column if not exists schedule_as uuid references public.task_content_format(id) on delete set null;
