-- Activity feed / notifications. A denormalized event log: each row carries a
-- ready-to-render `summary` so the feed is a single org-scoped query and stays
-- readable even after the underlying task/post/channel is deleted.
create table if not exists public.activity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  actor_id uuid references public.app_user(id) on delete set null,
  verb text not null,               -- created | completed | assigned | commented | published | stage_completed | channel_added | editor_added
  entity_type text not null,        -- task | post | comment | channel | editor
  entity_id uuid,                   -- soft link (no FK: entity may be deleted)
  channel_id uuid,                  -- optional context (workspace/channel)
  summary text not null,            -- human-readable, denormalized
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_org_created_idx on public.activity(org_id, created_at desc);
create index if not exists activity_channel_idx on public.activity(channel_id);
