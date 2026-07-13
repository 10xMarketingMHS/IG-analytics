-- Pulse — core schema (PRD §11)
-- Workspaces, membership/roles, taxonomy, posts, Instagram connections,
-- scoring config, reports, audit log.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profile — mirrors auth.users with the display fields the PRD's USER entity
-- needs (name) that auth.users doesn't carry.
-- ---------------------------------------------------------------------------
create table public.profile (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  name       text,
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- workspace + membership
-- ---------------------------------------------------------------------------
create table public.workspace (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  logo_url     text,
  brand_colors jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create type public.membership_role as enum ('admin', 'editor', 'viewer');

create table public.membership (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.membership_role not null default 'viewer',
  created_at   timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index membership_user_id_idx on public.membership (user_id);
create index membership_workspace_id_idx on public.membership (workspace_id);

-- ---------------------------------------------------------------------------
-- taxonomy — pillars, avatars, content types & formats (pillar-scoped),
-- format → post_type mapping.
-- ---------------------------------------------------------------------------
create type public.post_type as enum ('reel', 'carousel');

create table public.pillar (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  name         text not null,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table public.avatar (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  name         text not null,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table public.content_type (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  pillar_id    uuid not null references public.pillar (id) on delete cascade,
  name         text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (pillar_id, name)
);

create table public.format (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  pillar_id    uuid not null references public.pillar (id) on delete cascade,
  name         text not null,
  post_type    public.post_type not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (pillar_id, name)
);

create index content_type_pillar_id_idx on public.content_type (pillar_id);
create index format_pillar_id_idx on public.format (pillar_id);

-- ---------------------------------------------------------------------------
-- post — the record created (Planned) then logged (Published); see PRD §9.
-- ---------------------------------------------------------------------------
create type public.post_status as enum ('planned', 'published');
create type public.post_source as enum ('manual', 'instagram');

create table public.post (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspace (id) on delete cascade,
  date             date not null,
  title            text not null,
  caption          text,
  pillar_id        uuid not null references public.pillar (id),
  content_type_id  uuid not null references public.content_type (id),
  format_id        uuid not null references public.format (id),
  avatar_id        uuid not null references public.avatar (id),
  post_type        public.post_type not null,
  status           public.post_status not null default 'planned',
  published_at     timestamptz,

  views            bigint not null default 0,
  likes            bigint not null default 0,
  comments         bigint not null default 0,
  shares           bigint not null default 0,
  saves            bigint not null default 0,
  reach            bigint not null default 0,
  metrics_updated_at timestamptz,

  permalink        text,
  thumbnail_url    text,
  notes            text,

  source              public.post_source not null default 'manual',
  instagram_media_id  text,

  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint post_metrics_non_negative check (
    views >= 0 and likes >= 0 and comments >= 0 and
    shares >= 0 and saves >= 0 and reach >= 0
  ),
  constraint post_published_has_timestamp check (
    status = 'planned' or published_at is not null
  )
);

create index post_workspace_id_idx on public.post (workspace_id);
create index post_workspace_date_idx on public.post (workspace_id, date);
create index post_workspace_status_idx on public.post (workspace_id, status);
create index post_pillar_id_idx on public.post (pillar_id);
create index post_avatar_id_idx on public.post (avatar_id);
create unique index post_instagram_media_id_idx
  on public.post (workspace_id, instagram_media_id)
  where instagram_media_id is not null;

-- ---------------------------------------------------------------------------
-- instagram_connection, scoring_config, report, audit_log
-- ---------------------------------------------------------------------------
create table public.instagram_connection (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspace (id) on delete cascade,
  ig_account_id text not null,
  ig_username   text not null,
  access_token  text not null, -- encrypted at the application layer before storage
  connected_by  uuid references auth.users (id),
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, ig_account_id)
);

create table public.scoring_config (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  post_type    public.post_type not null,
  weights      jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, post_type)
);

create table public.report (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  type         text not null,
  period       text not null,
  share_token  text unique,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now()
);

create table public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  entity       text not null,
  entity_id    uuid not null,
  action       text not null,
  actor_id     uuid references auth.users (id),
  diff         jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_workspace_id_idx on public.audit_log (workspace_id, created_at desc);
