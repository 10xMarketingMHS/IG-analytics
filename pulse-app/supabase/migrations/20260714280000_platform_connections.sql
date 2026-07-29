-- Live platform integrations (Meta/Instagram first). One connection links a
-- Pulse account (channel × platform) to a real external account, holding an
-- ENCRYPTED long-lived access token. Never store the raw token.
create table if not exists public.platform_connection (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  account_id uuid not null references public.account(id) on delete cascade,
  provider text not null,                 -- 'instagram' | 'facebook' | 'youtube'
  external_id text not null,              -- IG business account id / FB page id / YT channel id
  external_name text,                     -- @handle / page name (display only)
  access_token_enc text not null,         -- AES-256-GCM ciphertext (see crypto.js)
  token_expires_at timestamptz,           -- long-lived token expiry, if known
  scope text,
  connected_by uuid references public.app_user(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_sync_status text,                  -- short human status of the most recent sync
  unique (account_id, provider)
);
create index if not exists platform_connection_org_idx on public.platform_connection(org_id);

-- Cache the resolved external media id + last sync time on each post so
-- re-syncs are cheap and idempotent.
alter table public.post
  add column if not exists external_id text,
  add column if not exists last_synced_at timestamptz;
