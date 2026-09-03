-- Self-service Hold/Release: record who applied the current hold.
--
-- Hold/Release is being widened from admin-only to (admin OR the task's own
-- assignee). held_by is PURELY INFORMATIONAL — it drives the "Held by [Name]"
-- badge, and is deliberately NOT read by the authorization check: release
-- permission never depends on who applied the hold.
--
-- References app_user (the identity table covering both admin and editor
-- logins), matching the actor_id / updated_by / connected_by convention used
-- for other "who did this" columns. on delete set null so removing a user
-- doesn't strand the task.
alter table public.task
  add column held_by uuid references public.app_user(id) on delete set null;
