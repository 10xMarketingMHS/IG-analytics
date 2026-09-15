-- Goals — per-admin ownership.
--
-- Each goal now belongs to a specific admin ("Goal For"), distinct from
-- created_by (who entered it). Lets the dashboard show/track goals separately
-- per admin. Nullable + backfilled to created_by for existing rows.
alter table public.goal add column owner_id uuid references public.app_user(id) on delete set null;
update public.goal set owner_id = created_by where owner_id is null;
create index goal_owner_idx on public.goal(owner_id);
