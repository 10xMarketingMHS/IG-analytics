-- Project tasks: a fourth task category, a full peer to Social / Ads / Service
-- (NOT a stripped-down category like Admin Tasks). Full to_do → in_progress →
-- review → completed workflow, full scoring, full leaderboard inclusion.
-- Modelled exactly on the Service migration; no special-casing anywhere.

-- 1. task_type: allow 'project' (keeping every existing value).
alter table public.task drop constraint if exists task_task_type_check;
alter table public.task
  add constraint task_task_type_check
  check (task_type in ('content', 'short_task', 'general', 'social', 'ad', 'admin', 'service', 'project'));

-- 2. task_content_format.category: allow 'project'. A Project "type" is an
--    ordinary content-format row (name, icon, points) plus the two Project-only
--    fields below.
alter table public.task_content_format drop constraint if exists task_content_format_category_check;
alter table public.task_content_format
  add constraint task_content_format_category_check check (category in ('social', 'ad', 'service', 'project'));

-- 2a. Project-type-only fields on task_content_format (nullable; meaningful only
--     for category = 'project'). `points` is reused directly, as for every other
--     category. duration_days bounds a project's Due Date; metrics_description is
--     free-form documentation ONLY — no scoring logic reads it.
alter table public.task_content_format
  add column if not exists duration_days       integer,
  add column if not exists metrics_description text;

-- 3. Per-brand id counter: allow the 'pid' kind (Project ID, numbered per brand
--    like SID/AID/SVID via next_brand_task_ref).
alter table public.task_brand_ref_seq drop constraint if exists task_brand_ref_seq_kind_check;
alter table public.task_brand_ref_seq
  add constraint task_brand_ref_seq_kind_check check (kind in ('sid', 'adid', 'svid', 'pid'));

-- 4. Store the Project id + start date on the task. pid is per-brand-unique like
--    sid/ad_id/svid; due_date already exists on task and is reused.
alter table public.task
  add column if not exists pid        text,
  add column if not exists start_date date;
create unique index if not exists task_pid_brand_uq
  on public.task(channel_id, pid) where pid is not null;
