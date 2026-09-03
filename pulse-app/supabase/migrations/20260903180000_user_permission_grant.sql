-- Access — per-user permission grants.
--
-- An ADDITIVE authorization layer on top of the role system (admin/editor/
-- viewer): an admin grants a SPECIFIC named permission to a SPECIFIC user, on
-- top of their role. Grants are strictly self-scoped — they only ever extend
-- what the grantee can do to their OWN data (enforced per-permission in the
-- route logic, not by this table).
--
-- Soft-revoke: revoked_at is set rather than the row deleted, so "who had
-- access to what, and when" stays answerable later — same durable-history
-- approach as task_review_log. permission_key is a hardcoded curated set in
-- code ('create_post' | 'goal_setting_access'), not a dynamic registry.
create table public.user_permission_grant (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.org(id) on delete cascade,
  user_id        uuid not null references public.app_user(id) on delete cascade,
  permission_key text not null,
  granted_by     uuid references public.app_user(id) on delete set null,
  granted_at     timestamptz not null default now(),
  revoked_at     timestamptz
);

-- At most one ACTIVE grant per (user, permission) in an org — re-granting after
-- a revoke inserts a fresh row, keeping the revoked one as history.
create unique index user_permission_grant_active_uq
  on public.user_permission_grant(org_id, user_id, permission_key)
  where revoked_at is null;

-- Fast "does this user have active grants" lookup (per request, not cached).
create index user_permission_grant_active_lookup
  on public.user_permission_grant(org_id, user_id) where revoked_at is null;
