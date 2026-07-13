-- Pulse — allow manual Post Type.
--
-- Previously handle_post_write() always overwrote post.post_type with the
-- selected format's post_type. Now post_type is user-selectable: the format
-- only supplies a default when no post_type is provided (e.g. a fallback),
-- so an explicitly-set value is respected on both insert and update.

create or replace function public.handle_post_write()
returns trigger
language plpgsql
as $$
begin
  -- Derive from the format only as a fallback (manual value wins).
  if new.post_type is null then
    select f.post_type into new.post_type
    from public.format f
    where f.id = new.format_id;
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at = now();
  end if;

  if tg_op = 'UPDATE' then
    if (
      new.views    is distinct from old.views    or
      new.likes    is distinct from old.likes    or
      new.comments is distinct from old.comments or
      new.shares   is distinct from old.shares   or
      new.saves    is distinct from old.saves    or
      new.reach    is distinct from old.reach
    ) then
      new.metrics_updated_at = now();
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;
