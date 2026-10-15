-- Per-task override of the content type's "link required for review" switch.
-- NULL = follow the content type (task_content_format.review_link_required);
-- true/false = whoever assigned the task decided for this one task.
alter table public.task add column if not exists review_link_required boolean;
