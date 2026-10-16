-- Who handed a task to its current assignee. With Assign tasks access, that
-- person may also review (approve / send back) the task. NULL = made for
-- themselves, picked up, or created automatically (e.g. from a post).
alter table public.task
  add column if not exists assigned_by uuid references public.app_user(id) on delete set null;

-- Backfill from what's recorded: the latest "assigned" entry that handed the
-- task to its current assignee; otherwise whoever created it — in both cases
-- only when that person isn't the assignee themselves.
update public.task t
   set assigned_by = coalesce(
         (select a.actor_id
            from public.activity a
           where a.entity_type = 'task' and a.entity_id = t.id and a.verb = 'assigned'
             and a.actor_id is not null and a.meta->>'toEditorId' = t.editor_id::text
             and not exists (select 1 from public.app_user u where u.id = a.actor_id and u.editor_id = t.editor_id)
           order by a.created_at desc
           limit 1),
         (select t.created_by
           where t.created_by is not null
             and not exists (select 1 from public.app_user u where u.id = t.created_by and u.editor_id = t.editor_id)))
 where t.assigned_by is null and t.editor_id is not null;
