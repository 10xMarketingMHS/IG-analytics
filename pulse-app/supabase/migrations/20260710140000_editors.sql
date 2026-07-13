-- Pulse — editors (people responsible for editing posts) + assignment.
-- RLS is not used (the Node backend is the authorization boundary), so no
-- policies are defined here.

create table public.editor (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  name         text not null,
  designation  text not null default '',
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index editor_workspace_id_idx on public.editor (workspace_id);

-- Which editor is responsible for a post (nullable — assignment is optional).
alter table public.post
  add column editor_id uuid references public.editor (id) on delete set null;

create index post_editor_id_idx on public.post (editor_id);
