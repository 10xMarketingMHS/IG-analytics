-- Per-brand (workspace) Social/Ad numbering.
--
-- Until now SID / AdID were ORG-wide: task_ref_seq is keyed by (org_id, kind),
-- and the uniqueness guards were task_sid_org_uq / task_adid_org_uq on
-- (org_id, <id>). Product decision: each BRAND (= workspace/channel = a task's
-- Project) gets its own SID and AID sequence, each conceptually starting at 1.
--
-- Chosen rollout: KEEP existing task ids, per-brand numbering GOING FORWARD.
-- To guarantee a new per-brand id can never collide with an org-wide id a brand
-- already used, each brand's counter is seeded ABOVE the highest number it has
-- already assigned (brands with no prior social/ad task start at 1).
--
-- TID stays org-wide and keeps being assigned to every task as an internal key;
-- only its display is retired in the UI. Mirrors the counter pattern already used
-- by next_task_ref() / next_taxonomy_serial().

-- 1. Per-brand counter (mirrors task_ref_seq, but keyed by workspace/brand).
create table if not exists public.task_brand_ref_seq (
  channel_id uuid not null references public.workspace(id) on delete cascade,
  kind text not null check (kind in ('sid', 'adid')),
  next_val bigint not null default 1,
  primary key (channel_id, kind)
);

create or replace function public.next_brand_task_ref(p_channel uuid, p_kind text)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into public.task_brand_ref_seq (channel_id, kind, next_val)
  values (p_channel, p_kind, 2)
  on conflict (channel_id, kind)
  do update set next_val = public.task_brand_ref_seq.next_val + 1
  returning next_val - 1 into v;
  return v;
end;
$$;

-- 2. Seed each brand's counters above any number it already used under the old
--    org-wide scheme, so "keep existing, per-brand going forward" cannot collide.
--    (Digits are pulled out of the stored id string — "SID-00007" -> 7 — so this
--    works regardless of the old "AdID" vs new "AID" prefix.)
insert into public.task_brand_ref_seq (channel_id, kind, next_val)
select channel_id, 'sid',
       max(nullif(regexp_replace(sid, '\D', '', 'g'), '')::bigint) + 1
from public.task
where sid is not null and channel_id is not null
group by channel_id
on conflict (channel_id, kind) do update set next_val = excluded.next_val;

insert into public.task_brand_ref_seq (channel_id, kind, next_val)
select channel_id, 'adid',
       max(nullif(regexp_replace(ad_id, '\D', '', 'g'), '')::bigint) + 1
from public.task
where ad_id is not null and channel_id is not null
group by channel_id
on conflict (channel_id, kind) do update set next_val = excluded.next_val;

-- 3. Uniqueness is now per-brand, not per-org (two brands may both hold SID-00001).
--    Existing rows stay valid: ids that were unique per org are also unique per
--    brand. TID's org-wide unique index (task_tid_org_uq) is left untouched.
drop index if exists public.task_sid_org_uq;
drop index if exists public.task_adid_org_uq;
create unique index if not exists task_sid_brand_uq
  on public.task(channel_id, sid) where sid is not null;
create unique index if not exists task_adid_brand_uq
  on public.task(channel_id, ad_id) where ad_id is not null;
