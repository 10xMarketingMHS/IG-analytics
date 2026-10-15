-- Time a task spends waiting for a reviewer never counts against the person
-- doing it. review_started_at is when it last went into Review (null while it
-- isn't there); review_wait_seconds is every finished wait added up. A task's
-- lateness is measured at completed_at minus that total — the moment it would
-- have been finished had every review happened instantly.
alter table public.task
  add column if not exists review_started_at timestamptz,
  add column if not exists review_wait_seconds numeric not null default 0;

-- Rebuild the history from what's already recorded: each submission is a
-- "review_requested" activity entry, and each decision (sent back or approved)
-- a task_review_log row. A wait runs from the first submission after the
-- previous decision up to the next decision.
with enters as (
  select a.entity_id as task_id, a.created_at as at
    from public.activity a
   where a.verb = 'review_requested' and a.entity_type = 'task' and a.entity_id is not null
), leaves as (
  select l.task_id, l.created_at as at,
         lag(l.created_at) over (partition by l.task_id order by l.created_at) as prev_at
    from public.task_review_log l
), waits as (
  select l.task_id,
         extract(epoch from l.at - (
           select min(e.at) from enters e
            where e.task_id = l.task_id and e.at < l.at and (l.prev_at is null or e.at > l.prev_at)
         )) as secs
    from leaves l
)
update public.task t
   set review_wait_seconds = w.total
  from (select task_id, sum(greatest(secs, 0)) as total from waits where secs is not null group by task_id) w
 where t.id = w.task_id;

-- Tasks sitting in Review right now: their current wait started at their
-- submission since the last decision (or now, if no record of it survives).
update public.task t
   set review_started_at = coalesce(
         (select min(a.created_at) from public.activity a
           where a.verb = 'review_requested' and a.entity_type = 'task' and a.entity_id = t.id
             and a.created_at > coalesce((select max(l.created_at) from public.task_review_log l where l.task_id = t.id), '-infinity')),
         now())
 where t.status = 'review' and t.review_started_at is null;
