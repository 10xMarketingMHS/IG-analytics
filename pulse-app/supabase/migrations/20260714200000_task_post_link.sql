-- Link a task to the post it was auto-created from (null for standalone/manual
-- tasks). ON DELETE SET NULL so deleting a post keeps its task as a standalone.
alter table public.task
  add column if not exists post_id uuid references public.post(id) on delete set null;
create index if not exists task_post_idx on public.task(post_id);
