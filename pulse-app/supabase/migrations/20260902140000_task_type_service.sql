-- Service tasks: a third task category, a full peer to Social and Ads.
--
-- Everything Social/Ads have, Service gets too: its own task_content_format
-- category (content types + points + time budgets + per-editor overrides), a
-- per-brand id counter (SVID, numbered like SID/AID), the full to_do →
-- in_progress → review → completed workflow, and full inclusion in scoring.
-- No special-casing anywhere — an ordinary task with a third category value.

-- 1. task_type: allow 'service' (keeping every existing value, incl. 'admin').
alter table public.task drop constraint if exists task_task_type_check;
alter table public.task
  add constraint task_task_type_check
  check (task_type in ('content', 'short_task', 'general', 'social', 'ad', 'admin', 'service'));

-- 2. task_content_format.category: allow 'service' alongside social/ad.
alter table public.task_content_format drop constraint if exists task_content_format_category_check;
alter table public.task_content_format
  add constraint task_content_format_category_check check (category in ('social', 'ad', 'service'));

-- 3. Per-brand id counter: allow the 'svid' kind.
alter table public.task_brand_ref_seq drop constraint if exists task_brand_ref_seq_kind_check;
alter table public.task_brand_ref_seq
  add constraint task_brand_ref_seq_kind_check check (kind in ('sid', 'adid', 'svid'));

-- 4. Store the Service id on the task, per-brand-unique like sid/ad_id.
alter table public.task add column if not exists svid text;
create unique index if not exists task_svid_brand_uq
  on public.task(channel_id, svid) where svid is not null;
