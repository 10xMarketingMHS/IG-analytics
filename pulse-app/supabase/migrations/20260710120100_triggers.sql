-- Pulse — triggers: workspace bootstrap, derived fields, audit log.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspace_set_updated_at
  before update on public.workspace
  for each row execute function public.set_updated_at();

create trigger scoring_config_set_updated_at
  before update on public.scoring_config
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- workspace bootstrap — creator becomes admin; seed default scoring weights
-- (Reels 20/15/25/25/15, Carousels 10/10/20/30/30 — PRD §10.3).
-- ---------------------------------------------------------------------------
create function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.membership (workspace_id, user_id, role)
  values (new.id, auth.uid(), 'admin');

  insert into public.scoring_config (workspace_id, post_type, weights)
  values
    (new.id, 'reel', jsonb_build_object(
      'views', 0.20, 'like_rate', 0.15, 'comment_rate', 0.25,
      'share_rate', 0.25, 'save_rate', 0.15
    )),
    (new.id, 'carousel', jsonb_build_object(
      'views', 0.10, 'like_rate', 0.10, 'comment_rate', 0.20,
      'share_rate', 0.30, 'save_rate', 0.30
    ));

  -- Default pillars & avatars (PRD §19). Content types/formats are not
  -- seeded here — they must come from the real sheet during migration
  -- (PRD §15) since the PRD doesn't enumerate the per-pillar cascade.
  insert into public.pillar (workspace_id, name, sort_order)
  values
    (new.id, 'Diabetes', 1),
    (new.id, 'Obesity', 2),
    (new.id, 'Kids', 3),
    (new.id, 'Nutrition Myths', 4),
    (new.id, 'Longevity', 5);

  insert into public.avatar (workspace_id, name, sort_order)
  values
    (new.id, 'Diabetes Patient', 1),
    (new.id, 'Parents', 2),
    (new.id, 'Working Professional', 3),
    (new.id, 'Senior Adult', 4),
    (new.id, 'Health Enthusiast', 5),
    (new.id, 'Weight Loss', 6),
    (new.id, 'Womens', 7);

  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspace
  for each row execute function public.handle_new_workspace();

-- ---------------------------------------------------------------------------
-- post: derive post_type from format_id; keep metrics_updated_at fresh;
-- stamp updated_at (PRD §11 note: "Post Type ... derived from Format").
-- ---------------------------------------------------------------------------
create function public.handle_post_write()
returns trigger
language plpgsql
as $$
begin
  select f.post_type into new.post_type
  from public.format f
  where f.id = new.format_id;

  if new.status = 'published' and new.published_at is null then
    new.published_at = now();
  end if;

  -- Nested IF (not a combined boolean AND) — Postgres does not guarantee
  -- short-circuit evaluation of AND, and OLD is unassigned on INSERT, so a
  -- single `tg_op = 'UPDATE' and old.x is distinct from new.x` expression
  -- can error with "record old is not assigned yet" during INSERT.
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

create trigger post_before_write
  before insert or update on public.post
  for each row execute function public.handle_post_write();

-- ---------------------------------------------------------------------------
-- audit log — record create/update/delete on post.
-- ---------------------------------------------------------------------------
create function public.log_post_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

create trigger post_audit_log
  after insert or update or delete on public.post
  for each row execute function public.log_post_change();
