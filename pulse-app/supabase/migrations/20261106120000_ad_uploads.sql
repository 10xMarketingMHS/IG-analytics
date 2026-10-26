-- Ad uploads: an approved Ad task waits in one list for the Managers and Team
-- Leads, who record which ads it became — the AD number Animus gave it (the VSL
-- team), or the ad's name or number another team sends back. One piece of work
-- can run as several ads. Run after 20261104120000_task_scheduling (its
-- "goes on after approval" tick on each task type decides which Ads types come
-- here). No job credit: it's record-keeping. Also Connected apps (below):
-- how Animus connects, with one line. Safe to run more than once.

-- On the task: when it came into the list (null: not in it).
alter table public.task add column if not exists upload_from timestamptz;
create index if not exists task_upload_idx on public.task(upload_from) where upload_from is not null;

-- The ads an approved Ad task became. An ad belongs to one task: the same
-- number or name can't be recorded twice for one brand.
create table if not exists public.task_ad (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.org(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  task_id      uuid not null references public.task(id) on delete cascade,
  ad_ref       text not null,
  -- manual (typed in Echo) or animus (sent by Animus, step 2)
  source       text not null default 'manual',
  created_by   uuid references public.app_user(id) on delete set null,
  created_at   timestamptz not null default now()
);
create unique index if not exists task_ad_ref_uniq on public.task_ad(workspace_id, lower(ad_ref));
create index if not exists task_ad_task_idx on public.task_ad(task_id);
alter table public.task_ad enable row level security;

-- This month's already-approved Ad work of those types goes into the list too.
update public.task t set upload_from = t.completed_at
  from public.task_content_format f
 where f.id = t.content_format_id and f.to_scheduling
   and t.task_type = 'ad' and t.status = 'done' and t.upload_from is null and t.completed_at is not null
   and t.completed_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');

-- Connected apps (Settings › Connected apps): another app — Animus first —
-- connects to one brand with one line Echo makes, shown once. Only a
-- fingerprint of the line's secret is kept; revoking it ends it at once.
create table if not exists public.app_connection (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.org(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  app          text not null default 'animus',
  label        text not null default '',
  secret_hash  text not null,
  created_by   uuid references public.app_user(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists app_connection_org_idx on public.app_connection(org_id);
alter table public.app_connection enable row level security;
