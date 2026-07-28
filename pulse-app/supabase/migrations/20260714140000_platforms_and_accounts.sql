-- Platforms & accounts (Phase 1 of the multi-platform architecture).
-- A Channel (workspace) can exist on many Platforms; each (channel × platform)
-- pairing is an Account — the real data source posts belong to.
-- Additive: existing posts keep working; post.platform_id is backfilled to
-- Instagram by the companion migration script.

-- Reference list of platforms (extensible — add a row for a new platform).
create table if not exists public.platform (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,          -- 'instagram' | 'facebook' | 'youtube' | ...
  name text not null,                -- display name
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- An account = one channel on one platform. API-ready: handle/external_id/token
-- columns are here now so future auto-sync attaches without another migration.
create table if not exists public.account (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,  -- channel
  platform_id uuid not null references public.platform(id) on delete cascade,
  handle text,          -- e.g. @doctorfarmer
  external_id text,     -- platform account id (future API use)
  access_token text,    -- future API auto-sync (kept server-side only)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, platform_id)
);
create index if not exists account_org_idx on public.account(org_id);
create index if not exists account_workspace_idx on public.account(workspace_id);

-- Every post is tagged with the platform it was published on.
alter table public.post add column if not exists platform_id uuid references public.platform(id);
create index if not exists post_platform_idx on public.post(platform_id);
