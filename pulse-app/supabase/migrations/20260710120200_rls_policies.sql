-- Pulse — Row-Level Security (PRD §14: "RLS enforces per-workspace privacy
-- at the DB layer"; PRD §8.1 FR-A3: roles enforced in UI *and* database).

-- ---------------------------------------------------------------------------
-- Helper functions — SECURITY DEFINER so they can read `membership` without
-- being subject to (and recursing into) membership's own RLS policies.
-- ---------------------------------------------------------------------------
create function public.is_workspace_member(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.membership
    where workspace_id = ws and user_id = auth.uid()
  );
$$;

create function public.workspace_role(ws uuid)
returns public.membership_role
language sql
security definer
stable
set search_path = public
as $$
  select role from public.membership
  where workspace_id = ws and user_id = auth.uid();
$$;

create function public.is_workspace_admin(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.workspace_role(ws) = 'admin';
$$;

create function public.can_edit_workspace(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.workspace_role(ws) in ('admin', 'editor');
$$;

-- ---------------------------------------------------------------------------
-- profile — a user may read/update only their own row.
-- ---------------------------------------------------------------------------
alter table public.profile enable row level security;

create policy profile_select_self on public.profile
  for select using (id = auth.uid());

create policy profile_update_self on public.profile
  for update using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- workspace
-- ---------------------------------------------------------------------------
alter table public.workspace enable row level security;

create policy workspace_select_member on public.workspace
  for select using (public.is_workspace_member(id));

create policy workspace_insert_authenticated on public.workspace
  for insert with check (auth.uid() is not null);

create policy workspace_update_admin on public.workspace
  for update using (public.is_workspace_admin(id));

-- ---------------------------------------------------------------------------
-- membership — members can see their workspace roster; only admins manage it.
-- ---------------------------------------------------------------------------
alter table public.membership enable row level security;

create policy membership_select_member on public.membership
  for select using (public.is_workspace_member(workspace_id));

create policy membership_insert_admin on public.membership
  for insert with check (public.is_workspace_admin(workspace_id));

create policy membership_update_admin on public.membership
  for update using (public.is_workspace_admin(workspace_id));

create policy membership_delete_admin on public.membership
  for delete using (public.is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- taxonomy (pillar, avatar, content_type, format) — members read, admins
-- write (FR-S1: taxonomy management is admin-gated global config).
-- ---------------------------------------------------------------------------
alter table public.pillar enable row level security;
alter table public.avatar enable row level security;
alter table public.content_type enable row level security;
alter table public.format enable row level security;

create policy pillar_select_member on public.pillar
  for select using (public.is_workspace_member(workspace_id));
create policy pillar_write_admin on public.pillar
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy avatar_select_member on public.avatar
  for select using (public.is_workspace_member(workspace_id));
create policy avatar_write_admin on public.avatar
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy content_type_select_member on public.content_type
  for select using (public.is_workspace_member(workspace_id));
create policy content_type_write_admin on public.content_type
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy format_select_member on public.format
  for select using (public.is_workspace_member(workspace_id));
create policy format_write_admin on public.format
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- post — members read; admins/editors write (viewers are read-only).
-- ---------------------------------------------------------------------------
alter table public.post enable row level security;

create policy post_select_member on public.post
  for select using (public.is_workspace_member(workspace_id));

create policy post_insert_editor on public.post
  for insert with check (public.can_edit_workspace(workspace_id));

create policy post_update_editor on public.post
  for update using (public.can_edit_workspace(workspace_id));

create policy post_delete_editor on public.post
  for delete using (public.can_edit_workspace(workspace_id));

-- ---------------------------------------------------------------------------
-- instagram_connection — sensitive tokens; admin only, both directions.
-- ---------------------------------------------------------------------------
alter table public.instagram_connection enable row level security;

create policy instagram_connection_admin_only on public.instagram_connection
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- scoring_config — members read, admins write (FR-S2).
-- ---------------------------------------------------------------------------
alter table public.scoring_config enable row level security;

create policy scoring_config_select_member on public.scoring_config
  for select using (public.is_workspace_member(workspace_id));
create policy scoring_config_write_admin on public.scoring_config
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- report — members manage their workspace's reports. Public share-link
-- access (FR-R2) is served through a server route using the service-role
-- client, validating share_token — not through anon RLS.
-- ---------------------------------------------------------------------------
alter table public.report enable row level security;

create policy report_select_member on public.report
  for select using (public.is_workspace_member(workspace_id));
create policy report_write_editor on public.report
  for all using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id));

-- ---------------------------------------------------------------------------
-- audit_log — members read; writes happen only via SECURITY DEFINER
-- triggers (see 20260710120100_triggers.sql), never direct client inserts.
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;

create policy audit_log_select_member on public.audit_log
  for select using (public.is_workspace_member(workspace_id));
