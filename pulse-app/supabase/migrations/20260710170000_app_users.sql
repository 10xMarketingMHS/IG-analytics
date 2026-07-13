-- Pulse — real user accounts for multi-user access control.
--
-- The app previously authenticated a single env-configured admin. This adds
-- persistent accounts; roles remain per-workspace via the existing
-- `membership` table (membership = access to a workspace; membership.role =
-- that user's role there). The env admin is seeded into this table on
-- startup so existing logins keep working.

create table public.app_user (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  name          text,
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
