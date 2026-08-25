-- Unified task tracking: every task gets a human-readable, sequential,
-- org-scoped reference id (TID-00001). Social and Paid Ad tasks additionally
-- get a secondary id (SID-00001 / AdID-00001) linked to the same row, so
-- either one can be searched directly and still resolve back to its parent
-- task. Mirrors the same "org-scoped sequential counter" pattern
-- next_taxonomy_serial() already uses for pillar/format/content-type serials.

create table public.task_ref_seq (
  org_id uuid not null references public.org(id) on delete cascade,
  kind text not null check (kind in ('tid', 'sid', 'adid')),
  next_val bigint not null default 1,
  primary key (org_id, kind)
);

create or replace function public.next_task_ref(p_org uuid, p_kind text)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into public.task_ref_seq (org_id, kind, next_val)
  values (p_org, p_kind, 2)
  on conflict (org_id, kind)
  do update set next_val = public.task_ref_seq.next_val + 1
  returning next_val - 1 into v;
  return v;
end;
$$;

alter table public.task
  add column tid text,
  add column sid text,
  add column ad_id text,
  -- Type-specific fields (platform/caption/asset links for Social; ad spend/
  -- platform/target URL for Paid Ad) — small and varying enough per type
  -- that a JSON bag beats a wide sparse column set for now.
  add column meta jsonb not null default '{}'::jsonb;

create unique index task_tid_org_uq on public.task(org_id, tid) where tid is not null;
create unique index task_sid_org_uq on public.task(org_id, sid) where sid is not null;
create unique index task_adid_org_uq on public.task(org_id, ad_id) where ad_id is not null;

-- "social" and "ad" join the existing task types — "content" stays reserved
-- for auto-created (post-linked) tasks, "short_task"/"general" unchanged.
alter table public.task drop constraint if exists task_task_type_check;
alter table public.task
  add constraint task_task_type_check check (task_type in ('content', 'short_task', 'general', 'social', 'ad'));

-- Backfill existing tasks with a TID (oldest first, so the numbering roughly
-- tracks creation order) — nothing had one before this migration.
do $$
declare r record; n bigint;
begin
  for r in select id, org_id from public.task where tid is null order by created_at loop
    n := public.next_task_ref(r.org_id, 'tid');
    update public.task set tid = 'TID-' || lpad(n::text, 5, '0') where id = r.id;
  end loop;
end;
$$;
