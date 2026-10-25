-- Social tasks after approval go into one shared list for the schedulers —
-- anyone with a Schedule goal that month — when their task type is ticked
-- "Goes to Scheduling" (Settings › Tasks & time). Whoever sets a task's post
-- date takes it; they post it, and two days later paste each platform's link: every link
-- becomes a post on the same SID (post.from_task_id), so nobody fills in Add
-- Post for it. Safe to run more than once.

-- On the task: who took it (null: still in the shared list), when it went into
-- scheduling (null: not in it), and when it's to be posted.
alter table public.task add column if not exists scheduler_id uuid references public.editor(id) on delete set null;
alter table public.task add column if not exists schedule_from timestamptz;
alter table public.task add column if not exists post_on date;
alter table public.task add column if not exists post_time time;
create index if not exists task_scheduling_idx on public.task(scheduler_id) where schedule_from is not null;

-- Which task types go on once approved: the Social ones that are posted
-- (Reels, Carousel, Post…) to Scheduling, not Thumbnails; every Ads type to Ad
-- uploads (20261106120000_ad_uploads). Set once, the first time this runs;
-- after that it's Settings › Tasks & time.
alter table public.task_content_format add column if not exists to_scheduling boolean;
update public.task_content_format set to_scheduling = coalesce((category = 'social' and lower(name) not like '%thumbnail%') or category = 'ad', false)
 where to_scheduling is null;
alter table public.task_content_format alter column to_scheduling set default false;
alter table public.task_content_format alter column to_scheduling set not null;

-- A post made from a task's link points back at the task.
alter table public.post add column if not exists from_task_id uuid references public.task(id) on delete set null;
create index if not exists post_from_task_idx on public.post(from_task_id) where from_task_id is not null;

-- This month's already-approved social work of those types goes into the list too.
update public.task t set schedule_from = t.completed_at
  from public.task_content_format f
 where f.id = t.content_format_id and f.to_scheduling
   and t.task_type = 'social' and t.post_id is null and t.status = 'done' and t.schedule_from is null and t.completed_at is not null
   and t.completed_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
