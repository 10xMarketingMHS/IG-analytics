-- Ads teams, Ad uploads and Connected apps. Run after
-- 20261104120000_task_scheduling (its "goes on after approval" tick on each
-- task type decides which Ads types come to Ad uploads). Safe to run more than
-- once.
--
-- Ads are made for teams — VSL, Longer Life, Webinar — not for brands: an Ad
-- task picks its team, and is numbered per team (AID-00001…). The task type
-- stays shared ("Ad Video"), so an editor's goal is one target whatever team
-- the ads are for. An approved Ad task waits in Ad uploads for the Managers
-- and Team Leads, who record which ads it became — the AD number Animus gave
-- it (the VSL team), or the ad's name another team sends back. No job credit:
-- it's record-keeping.

-- The teams (Settings › Tasks & time › Ads teams), each with its lead, and the
-- last AID number it gave.
create table if not exists public.ad_team (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.org(id) on delete cascade,
  name       text not null,
  lead_name  text not null default '',
  sort_order int not null default 0,
  active     boolean not null default true,
  next_aid   int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists ad_team_name_uniq on public.ad_team(org_id, lower(name));
alter table public.ad_team enable row level security;

-- On the task: its team (Ads), and when it came into Ad uploads (null: not in it).
alter table public.task add column if not exists ad_team_id uuid references public.ad_team(id) on delete set null;
create index if not exists task_ad_team_idx on public.task(ad_team_id) where ad_team_id is not null;
-- AIDs are unique within a team, as they are within a brand
create unique index if not exists task_adid_team_uq on public.task(ad_team_id, ad_id) where ad_team_id is not null and ad_id is not null;
alter table public.task add column if not exists upload_from timestamptz;
create index if not exists task_upload_idx on public.task(upload_from) where upload_from is not null;

-- The ads an approved Ad task became. An ad belongs to one task: the same
-- number or name can't be recorded twice for one team (or, for an Ad task
-- made before teams, one brand).
create table if not exists public.task_ad (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.org(id) on delete cascade,
  workspace_id uuid references public.workspace(id) on delete cascade,
  task_id      uuid not null references public.task(id) on delete cascade,
  ad_ref       text not null,
  -- manual (typed in Echo) or animus (sent by Animus)
  source       text not null default 'manual',
  created_by   uuid references public.app_user(id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.task_ad alter column workspace_id drop not null;
alter table public.task_ad add column if not exists ad_team_id uuid references public.ad_team(id) on delete cascade;
drop index if exists public.task_ad_ref_uniq;
create unique index if not exists task_ad_scope_ref_uniq on public.task_ad(coalesce(ad_team_id, workspace_id), lower(ad_ref));
create index if not exists task_ad_task_idx on public.task_ad(task_id);
alter table public.task_ad enable row level security;

-- This month's already-approved Ad work of those types goes into the list too.
update public.task t set upload_from = t.completed_at
  from public.task_content_format f
 where f.id = t.content_format_id and f.to_scheduling
   and t.task_type = 'ad' and t.status = 'done' and t.upload_from is null and t.completed_at is not null
   and t.completed_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');

-- Connected apps (Settings › Connected apps): another app — Animus first —
-- connects to one Ads team with one line Echo makes, shown once. Only a
-- fingerprint of the line's secret is kept; revoking it ends it at once.
create table if not exists public.app_connection (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.org(id) on delete cascade,
  workspace_id uuid references public.workspace(id) on delete cascade,
  app          text not null default 'animus',
  label        text not null default '',
  secret_hash  text not null,
  created_by   uuid references public.app_user(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
alter table public.app_connection alter column workspace_id drop not null;
alter table public.app_connection add column if not exists ad_team_id uuid references public.ad_team(id) on delete cascade;
create index if not exists app_connection_org_idx on public.app_connection(org_id);
alter table public.app_connection enable row level security;
