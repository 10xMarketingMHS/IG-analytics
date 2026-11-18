-- Knowledge Hub: the team's SOPs, brand guidelines and training, kept in Echo
-- (server/src/routes/knowledge.js). Shelves group the items — SOPs, Brand
-- guidelines and Training to start (the server adds those three the first time
-- the hub opens) and any others the team adds. An item is a page written in
-- Echo plus links to files kept elsewhere (Google Drive, Docs, YouTube),
-- company-wide or for one brand. Nothing is uploaded. Safe to run more than once.

create table if not exists public.knowledge_shelf (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.org(id) on delete cascade,
  name       text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists knowledge_shelf_name_uq on public.knowledge_shelf(org_id, lower(name));

create table if not exists public.knowledge_item (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.org(id) on delete cascade,
  shelf_id   uuid not null references public.knowledge_shelf(id) on delete restrict,
  brand_id   uuid references public.workspace(id) on delete set null,
  title      text not null,
  body       text not null default '',
  links      jsonb not null default '[]'::jsonb,
  pinned     boolean not null default false,
  created_by uuid references public.app_user(id) on delete set null,
  updated_by uuid references public.app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists knowledge_item_org_idx on public.knowledge_item(org_id) where deleted_at is null;

create index if not exists knowledge_item_shelf_idx on public.knowledge_item(shelf_id);
