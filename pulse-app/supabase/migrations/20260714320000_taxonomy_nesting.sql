-- Taxonomy restructure: Pillar → Type nesting with permanent per-scope serials,
-- and Format decoupled from Pillar (flat, channel-wide).
--   • Pillar → numbered per channel                 (P1, P2, …)
--   • Type   → nested under Pillar, numbered per pillar (T1, …)
--   • Format → flat & channel-wide (no pillar), numbered per channel (F1, …)
-- Serials are permanent DISPLAY codes: gaps allowed, never reused. Post foreign
-- keys keep pointing at row ids, never the serial.
-- NOTE: apply-migration.js already wraps this file in one transaction.

-- 1. Monotonic per-scope counters. parent_id = pillar_id for the 'type' scope;
--    NULL for the channel-wide 'pillar' and 'format' scopes.
create table if not exists public.taxonomy_seq (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  kind         text not null check (kind in ('pillar','type','format')),
  parent_id    uuid,
  next_val     integer not null default 1
);

-- Exactly one counter row per scope. A NULL parent_id would otherwise be
-- "distinct" every time, so collapse it to a fixed sentinel in the unique key.
create unique index if not exists taxonomy_seq_scope_idx on public.taxonomy_seq
  (workspace_id, kind, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Atomically hand out the next serial for a scope (never reused; gaps allowed).
create or replace function public.next_taxonomy_serial(p_ws uuid, p_kind text, p_parent uuid)
returns integer language plpgsql as $$
declare v integer;
begin
  insert into public.taxonomy_seq (workspace_id, kind, parent_id, next_val)
  values (p_ws, p_kind, p_parent, 2)
  on conflict (workspace_id, kind, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set next_val = public.taxonomy_seq.next_val + 1
  returning next_val - 1 into v;
  return v;
end $$;

-- 2. Serial display codes — real integers, so ordering is numeric (P10 > P2).
alter table public.pillar       add column if not exists serial integer;
alter table public.content_type add column if not exists serial integer;
alter table public.format       add column if not exists serial integer;

-- 3. Flatten Format. Merge same-name duplicates per channel (survivor = earliest
--    created), repoint any posts to the survivor, then drop the pillar parentage.
update public.post p set format_id = keep.id
from public.format dup
join lateral (
  select id from public.format s
  where s.workspace_id = dup.workspace_id and s.name = dup.name
  order by s.created_at, s.id limit 1
) keep on true
where p.format_id = dup.id and dup.id <> keep.id;

delete from public.format f
where f.id not in (
  select distinct on (workspace_id, name) id
  from public.format order by workspace_id, name, created_at, id
);

-- Drops the column plus its FK (format_pillar_id_fkey), the unique(pillar_id,name)
-- constraint, and format_pillar_id_idx.
alter table public.format drop column if exists pillar_id cascade;
create unique index if not exists format_workspace_name_key on public.format (workspace_id, name);

-- 4. Backfill serials for existing rows.
update public.pillar p set serial = r.rn
from (select id, row_number() over (partition by workspace_id order by sort_order, created_at, id) rn from public.pillar) r
where r.id = p.id;

update public.content_type c set serial = r.rn
from (select id, row_number() over (partition by pillar_id order by created_at, id) rn from public.content_type) r
where r.id = c.id;

update public.format f set serial = r.rn
from (select id, row_number() over (partition by workspace_id order by created_at, id) rn from public.format) r
where r.id = f.id;

-- 5. Seed each counter to max(serial)+1 so future inserts continue (gaps kept).
insert into public.taxonomy_seq (workspace_id, kind, parent_id, next_val)
  select workspace_id, 'pillar', null, coalesce(max(serial),0)+1 from public.pillar group by workspace_id;
insert into public.taxonomy_seq (workspace_id, kind, parent_id, next_val)
  select workspace_id, 'type', pillar_id, coalesce(max(serial),0)+1 from public.content_type group by workspace_id, pillar_id;
insert into public.taxonomy_seq (workspace_id, kind, parent_id, next_val)
  select workspace_id, 'format', null, coalesce(max(serial),0)+1 from public.format group by workspace_id;

-- 6. Enforce serials now that every row has one.
alter table public.pillar       alter column serial set not null;
alter table public.content_type alter column serial set not null;
alter table public.format       alter column serial set not null;
