-- Collab: which other channel a post is a collaboration with (optional).
alter table public.post
  add column if not exists collab_channel_id uuid references public.workspace(id) on delete set null;
create index if not exists post_collab_idx on public.post(collab_channel_id);
