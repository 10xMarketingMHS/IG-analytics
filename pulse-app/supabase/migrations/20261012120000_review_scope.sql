-- Review scope — narrows a resolve_tasks grant to specific people or tasks.
--
-- NULL (the default) keeps the original meaning: the grantee may approve or
-- send back ANY task in review. Otherwise it holds the only work they may
-- review:
--   { "editors": [ { "editorId": "<uuid>", "taskIds": null | ["<uuid>", ...] } ] }
-- taskIds null = every task assigned to that team member; a list = only those
-- tasks. An empty "editors" list means the grantee can review nothing yet.
-- Only meaningful on the resolve_tasks row; ignored for every other key.
alter table public.user_permission_grant add column if not exists scope jsonb;
