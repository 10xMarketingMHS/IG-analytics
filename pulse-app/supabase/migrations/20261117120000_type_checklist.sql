-- Each task type's checklist (Settings › Tasks & time › Checklist): the steps
-- every new task of the type starts with, as ten checks for Reels. The items a
-- task gets from its type are marked from_type: whoever does the task ticks
-- them but can't remove or rename them; an admin, or whoever assigned the task,
-- can. Every item on a task, from its type or added by hand, is ticked before
-- the work goes to Review (server/src/routes/tasks.js). Tasks made before a
-- type had its list keep the checklist they have. Safe to run more than once.

alter table public.task_content_format add column if not exists checklist jsonb not null default '[]'::jsonb;
alter table public.subtask add column if not exists from_type boolean not null default false;
