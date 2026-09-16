-- Daily history of each platform connection's follower/subscriber count.
-- platform_connection.follower_count only holds the LATEST value; this records
-- one row per connection per (IST) day so the dashboard can show the follower
-- count as of a selected date range and the growth over it. History accrues
-- going forward — it can't reconstruct days that were never captured.
create table if not exists public.follower_snapshot (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  connection_id uuid not null references public.platform_connection(id) on delete cascade,
  provider text not null,
  follower_count integer not null,
  day date not null,                 -- IST calendar day of capture
  captured_at timestamptz not null default now(),
  unique (connection_id, day)
);
create index if not exists follower_snapshot_conn_day on public.follower_snapshot(connection_id, day desc);
create index if not exists follower_snapshot_org_idx on public.follower_snapshot(org_id);
