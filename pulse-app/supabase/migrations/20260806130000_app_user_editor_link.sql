-- Pulse — link a login account to its team-member (editor) identity.
-- Additive only. `app_user` (who logs in) and `editor` (who content/tasks get
-- assigned to) were previously unrelated tables, so the app had no way to
-- resolve "which tasks are assigned to *me*". An admin sets this once per
-- user (Settings → User management); it's nullable so nothing breaks for
-- users who aren't also an editor (e.g. an admin-only login).

alter table public.app_user
  add column if not exists editor_id uuid references public.editor(id) on delete set null;

create index if not exists app_user_editor_idx on public.app_user(editor_id);
