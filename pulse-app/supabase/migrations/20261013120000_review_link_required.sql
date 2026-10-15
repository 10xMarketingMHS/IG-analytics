-- Whether a task of this content type must carry a delivery link before it can
-- be submitted for review. On by default: a reviewer needs the output to judge
-- it. Switched off per type (Task Settings) for work with nothing to link to —
-- scheduling, data, technical tasks and the like.
alter table public.task_content_format
  add column if not exists review_link_required boolean not null default true;
