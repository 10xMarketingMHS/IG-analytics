-- Social tasks after approval: the brand's scheduler sets the post date, posts
-- it, and two days later pastes each platform's link; every link becomes a post
-- on the same SID (post.from_task_id), so nobody fills in Add Post for it.
-- Safe to run more than once.

-- Who schedules a brand's approved social work (a person on the roster with a login).
alter table public.workspace add column if not exists scheduler_id uuid references public.editor(id) on delete set null;

-- On the task: who schedules it (the brand's scheduler when it was approved),
-- when it went to them (null: not in scheduling), and when it's to be posted.
alter table public.task add column if not exists scheduler_id uuid references public.editor(id) on delete set null;
alter table public.task add column if not exists schedule_from timestamptz;
alter table public.task add column if not exists post_on date;
alter table public.task add column if not exists post_time time;
create index if not exists task_scheduler_idx on public.task(scheduler_id) where schedule_from is not null;

-- A post made from a task's link points back at the task.
alter table public.post add column if not exists from_task_id uuid references public.task(id) on delete set null;
create index if not exists post_from_task_idx on public.post(from_task_id) where from_task_id is not null;
