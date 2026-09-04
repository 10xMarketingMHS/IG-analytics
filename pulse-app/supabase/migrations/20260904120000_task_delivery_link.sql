-- Delivery Link on a task — a URL to the completed deliverable/asset.
--
-- Distinct from a published post's URL (post.permalink): this is the delivered
-- work on the TASK itself. Nullable; set via PATCH /tasks/:id by the assignee
-- or an admin, and never used for task_type = 'admin' tasks.
alter table public.task add column delivery_link text;
