-- The audit log no longer records a post change that only touches the synced
-- numbers (views, reach, likes, comments, shares, saves), the Instagram link
-- (external_id) and the sync / update times. Every Instagram or YouTube sync
-- rewrites each synced post, and each rewrite wrote a full before-and-after
-- copy of the post into audit_log — about 170 KB a sync, never read — which
-- would fill a small database's storage. Real edits (title, date, caption,
-- editor, status …), new posts and deletes are recorded as before.
-- Then the rows already written for number-only changes are removed.
-- Safe to run more than once.

create or replace function public.log_post_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  synced constant text[] := array[
    'views', 'reach', 'likes', 'comments', 'shares', 'saves', 'external_id',
    'last_synced_at', 'metrics_updated_at', 'updated_at'
  ];
begin
  -- Nested IF: OLD isn't assigned on INSERT (see handle_post_write).
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - synced) = (to_jsonb(old) - synced) then
      return new; -- only the synced numbers changed: nothing to record
    end if;
  end if;

  insert into public.audit_log (workspace_id, entity, entity_id, action, actor_id, diff)
  values (
    coalesce(new.workspace_id, old.workspace_id),
    'post',
    coalesce(new.id, old.id),
    lower(tg_op),
    auth.uid(),
    case tg_op
      when 'INSERT' then to_jsonb(new)
      when 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))
      when 'DELETE' then to_jsonb(old)
    end
  );
  return coalesce(new, old);
end;
$$;

-- the number-only rows already written
delete from public.audit_log
 where entity = 'post' and action = 'update'
   and (diff->'after') - array['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'external_id', 'last_synced_at', 'metrics_updated_at', 'updated_at']
     = (diff->'before') - array['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'external_id', 'last_synced_at', 'metrics_updated_at', 'updated_at'];
