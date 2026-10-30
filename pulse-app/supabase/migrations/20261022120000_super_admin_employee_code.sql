-- Team › Roster (Pulse Redesign v5).
--
-- Super Admin sits above Admin: a flag on the login, on top of the admin role
-- (membership.role stays 'admin', so every existing admin check still holds).
-- Only a Super Admin can make, change or remove an admin. The env-configured
-- bootstrap admin is set as one on every server start.
--
-- Employee code: each team member's company ID (e.g. MHS001), shown and edited
-- on the roster. Free text; blank is null.
alter table public.app_user add column if not exists is_super_admin boolean not null default false;
alter table public.editor add column if not exists employee_code text;
