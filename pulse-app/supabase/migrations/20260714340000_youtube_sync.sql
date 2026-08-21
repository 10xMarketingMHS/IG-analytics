-- YouTube Tier 1: public stats via one org-wide API key (no OAuth, no token to
-- store). Because there's no per-channel auth, YouTube gets no platform_connection
-- row — the per-account sync state lives directly on the account row instead,
-- mirroring the fields platform_connection carries for Instagram.
--
-- All additions are nullable, so this is backward-compatible: existing rows and
-- code that doesn't know these columns keep working unchanged.
alter table public.account
  add column if not exists last_synced_at   timestamptz,
  add column if not exists last_sync_status text,
  add column if not exists subscriber_count integer,
  add column if not exists external_name    text;
