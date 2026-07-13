-- Pulse — decouple from Supabase Auth.
--
-- The app no longer uses Supabase Auth/RLS: a Node/Express backend now
-- owns authentication (a single env-configured admin credential) and
-- authorization entirely in application code. This migration removes the
-- auth.users-triggered bootstrap logic, the RLS policies (inert anyway
-- once queries run as the postgres role instead of through PostgREST),
-- and the auth.users foreign keys so user-reference columns become plain
-- UUIDs the backend controls itself.

-- ---------------------------------------------------------------------------
-- Drop RLS policies + disable RLS (policy drops must happen before the
-- table/function drops below, since `drop table` removes public.profile
-- and any later `drop policy ... on public.profile` would then fail even
-- with IF EXISTS — IF EXISTS only guards a missing policy, not a missing
-- table). The Node backend is now the sole authorization boundary; leaving
-- policies in place that reference auth.uid() (always NULL outside
-- PostgREST) would be misleading.
-- ---------------------------------------------------------------------------
drop policy if exists profile_select_self on public.profile;
drop policy if exists profile_update_self on public.profile;

drop policy if exists workspace_select_member on public.workspace;
drop policy if exists workspace_insert_authenticated on public.workspace;
drop policy if exists workspace_update_admin on public.workspace;
alter table public.workspace disable row level security;

drop policy if exists membership_select_member on public.membership;
drop policy if exists membership_insert_admin on public.membership;
drop policy if exists membership_update_admin on public.membership;
drop policy if exists membership_delete_admin on public.membership;
alter table public.membership disable row level security;

drop policy if exists pillar_select_member on public.pillar;
drop policy if exists pillar_write_admin on public.pillar;
alter table public.pillar disable row level security;

drop policy if exists avatar_select_member on public.avatar;
drop policy if exists avatar_write_admin on public.avatar;
alter table public.avatar disable row level security;

drop policy if exists content_type_select_member on public.content_type;
drop policy if exists content_type_write_admin on public.content_type;
alter table public.content_type disable row level security;

drop policy if exists format_select_member on public.format;
drop policy if exists format_write_admin on public.format;
alter table public.format disable row level security;

drop policy if exists post_select_member on public.post;
drop policy if exists post_insert_editor on public.post;
drop policy if exists post_update_editor on public.post;
drop policy if exists post_delete_editor on public.post;
alter table public.post disable row level security;

drop policy if exists instagram_connection_admin_only on public.instagram_connection;
alter table public.instagram_connection disable row level security;

drop policy if exists scoring_config_select_member on public.scoring_config;
drop policy if exists scoring_config_write_admin on public.scoring_config;
alter table public.scoring_config disable row level security;

drop policy if exists report_select_member on public.report;
drop policy if exists report_write_editor on public.report;
alter table public.report disable row level security;

drop policy if exists audit_log_select_member on public.audit_log;
alter table public.audit_log disable row level security;

drop function if exists public.is_workspace_member(uuid);
drop function if exists public.workspace_role(uuid);
drop function if exists public.is_workspace_admin(uuid);
drop function if exists public.can_edit_workspace(uuid);

-- ---------------------------------------------------------------------------
-- Drop the auth.users-triggered bootstrap (profile mirror, workspace seed) —
-- now that their policies are gone, the tables/functions can drop cleanly.
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.profile;

drop trigger if exists on_workspace_created on public.workspace;
drop function if exists public.handle_new_workspace();

-- ---------------------------------------------------------------------------
-- Drop auth.users foreign keys — these columns are now backend-controlled
-- plain UUIDs (the Node backend's fixed ADMIN_USER_ID for a single-admin
-- setup today; real per-user FKs can return if multi-user auth comes back).
-- ---------------------------------------------------------------------------
alter table public.membership drop constraint if exists membership_user_id_fkey;
alter table public.post drop constraint if exists post_created_by_fkey;
alter table public.instagram_connection drop constraint if exists instagram_connection_connected_by_fkey;
alter table public.report drop constraint if exists report_created_by_fkey;
alter table public.audit_log drop constraint if exists audit_log_actor_id_fkey;
