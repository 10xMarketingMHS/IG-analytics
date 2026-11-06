-- Settings (Pulse Redesign v5).
--
-- org.settings: the workspace-wide settings an admin changes on Settings ›
-- General — the week start ("mon" | "sun") and the work calendar (weekday and
-- Saturday hours, whether breaks apply on Saturdays, a sick-leave buffer and a
-- capacity adjustment). Each month's capacity is worked out from the calendar
-- when no explicit capacity is saved for it.
--
-- app_user.notify_prefs: which in-app alerts a person gets (Settings ›
-- Notifications). A missing key means on.
alter table public.org add column if not exists settings jsonb not null default '{}'::jsonb;
alter table public.app_user add column if not exists notify_prefs jsonb not null default '{}'::jsonb;
