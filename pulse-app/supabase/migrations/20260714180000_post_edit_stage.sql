-- Editing pipeline stage for each post (Metrics board). Separate from the
-- publish status (planned/published).
alter table public.post
  add column if not exists edit_stage text not null default 'not_started'
  check (edit_stage in ('not_started','in_progress','in_review','pending','completed'));
create index if not exists post_edit_stage_idx on public.post(edit_stage);
