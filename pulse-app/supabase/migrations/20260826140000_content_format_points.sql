-- Points Formula: base_points now comes directly from an admin-set value per
-- content format (Reel/Poster/Shoot/etc.), not from budget_hours — a format's
-- point value and its time budget are two independent admin decisions now.
-- Default 1 so nothing scores 0 before an admin configures real values.
alter table public.task_content_format
  add column if not exists points numeric(6,2) not null default 1;
