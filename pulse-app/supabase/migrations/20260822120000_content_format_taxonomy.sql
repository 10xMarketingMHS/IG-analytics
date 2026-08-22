-- Content Format becomes a real, admin-manageable taxonomy (like Pillars or
-- Avatars) instead of a fixed enum — an org can add/rename/retire its own
-- categories (Podcast, Livestream, whatever fits how it actually works).
-- Org-scoped, like Editor: it's about *how* work gets made, not tied to one
-- channel.
--
-- This feature hasn't shipped yet (still on an unmerged branch), so there's
-- no real production data riding on the old enum — it's replaced outright
-- rather than kept alongside the new taxonomy table.

create table public.task_content_format (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  name text not null,
  icon text not null default '🔧',
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create index task_content_format_org_idx on public.task_content_format(org_id);

-- Seed the previous 4 built-ins for every existing org, so nothing looks empty.
insert into public.task_content_format (org_id, name, icon, sort_order)
select o.id, v.name, v.icon, v.sort_order
  from public.org o
  cross join (values ('Video','🎬',1), ('Image','🖼️',2), ('Shoot','📷',3), ('Other','🔧',4)) as v(name, icon, sort_order);

-- task.content_format (text enum) → content_format_id (FK).
alter table public.task
  add column content_format_id uuid references public.task_content_format(id) on delete set null;
update public.task t
   set content_format_id = f.id
  from public.task_content_format f
 where f.org_id = t.org_id and lower(f.name) = t.content_format;
alter table public.task drop column content_format;

-- task_time_rule.content_format (text enum) → content_format_id (FK, required).
alter table public.task_time_rule
  add column content_format_id uuid references public.task_content_format(id) on delete cascade;
update public.task_time_rule r
   set content_format_id = f.id
  from public.task_content_format f
 where f.org_id = r.org_id and lower(f.name) = r.content_format;
alter table public.task_time_rule drop column content_format;
alter table public.task_time_rule alter column content_format_id set not null;

-- Re-create the "one global default, one override per editor" rules against
-- the new column (the old ones were on the now-dropped text column).
drop index if exists task_time_rule_global_uq;
drop index if exists task_time_rule_editor_uq;
create unique index task_time_rule_global_uq
  on public.task_time_rule(org_id, content_format_id) where editor_id is null;
create unique index task_time_rule_editor_uq
  on public.task_time_rule(org_id, content_format_id, editor_id) where editor_id is not null;
