-- Auto-sync infrastructure. All additive/nullable-or-defaulted, so existing rows
-- and code that predates these columns keep working unchanged.
--
-- On platform_connection (used by IG, FB AND YouTube — YouTube's connect upserts
-- a row too, despite the older youtube_sync migration's comment):
--   sync_in_progress + sync_started_at  — one shared in-flight lock per
--     connection, so a browser's next interval tick, or a different user's tab,
--     never fires a redundant concurrent sync on the same channel. sync_started_at
--     lets a lock left behind by a crashed sync auto-expire instead of wedging.
--   consecutive_failures + last_error_type — failure classification & backoff:
--     transient (429/5xx/timeout) backs off exponentially and resets on success;
--     permanent (expired/revoked token) stops auto-retry and asks for a reconnect.
alter table public.platform_connection
  add column if not exists sync_in_progress    boolean not null default false,
  add column if not exists sync_started_at      timestamptz,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_error_type      text
    check (last_error_type in ('transient', 'permanent'));

-- Org-level auto-sync controls, admin-adjustable WITHOUT a deploy (this app's
-- deploy pipeline has been fragile). Kill switch ships OFF; interval starts
-- conservative at 30 min and is only tightened after watching pooler behavior.
alter table public.org
  add column if not exists auto_sync_enabled          boolean not null default false,
  add column if not exists auto_sync_interval_minutes integer not null default 30
    check (auto_sync_interval_minutes >= 5 and auto_sync_interval_minutes <= 1440);
