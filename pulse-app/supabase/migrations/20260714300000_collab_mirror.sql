-- Instagram collab: a post can be mirrored onto the collaborating channel.
-- The owner row + mirror row share collab_group_id; the mirror is flagged so it
-- is excluded from performance aggregates everywhere and from org-wide count /
-- content-mix, while still counting in the collab channel's OWN scoped count.
-- The mirror never syncs directly — its metrics are copied from the owner row.
alter table public.post
  add column if not exists collab_group_id uuid,
  add column if not exists is_collab_mirror boolean not null default false;

create index if not exists post_collab_group_idx
  on public.post(collab_group_id) where collab_group_id is not null;
