-- Who created a task. Lets the app tell a task someone made for themselves
-- (theirs to edit or delete until it's approved) from one an admin assigned to
-- them (whose title, dates and type they can't change). NULL = unknown / created
-- automatically (e.g. from a post) — treated as assigned.
alter table public.task add column if not exists created_by uuid references public.app_user(id) on delete set null;

-- Backfill from the activity feed's "created" entries.
update public.task t
   set created_by = a.actor_id
  from (
    select distinct on (entity_id) entity_id, actor_id
      from public.activity
     where entity_type = 'task' and verb = 'created' and actor_id is not null
     order by entity_id, created_at
  ) a
 where a.entity_id = t.id and t.created_by is null;
