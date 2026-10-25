-- Social tasks after approval go into one shared list for the schedulers —
-- anyone with a Schedule goal that month. Whoever sets a task's post date takes
-- it; they post it, and two days later paste each platform's link: every link
-- becomes a post on the same SID (post.from_task_id), so nobody fills in Add
-- Post for it. Safe to run more than once.

-- On the task: who took it (null: still in the shared list), when it went into
-- scheduling (null: not in it), and when it's to be posted.
alter table public.task add column if not exists scheduler_id uuid references public.editor(id) on delete set null;
alter table public.task add column if not exists schedule_from timestamptz;
alter table public.task add column if not exists post_on date;
alter table public.task add column if not exists post_time time;
create index if not exists task_scheduling_idx on public.task(scheduler_id) where schedule_from is not null;

-- A post made from a task's link points back at the task.
alter table public.post add column if not exists from_task_id uuid references public.task(id) on delete set null;
create index if not exists post_from_task_idx on public.post(from_task_id) where from_task_id is not null;

-- This month's already-approved social work goes into the list too.
update public.task set schedule_from = completed_at
 where task_type = 'social' and post_id is null and status = 'done' and schedule_from is null and completed_at is not null
   and completed_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
