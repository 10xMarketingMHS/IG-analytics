-- Pulse — Content Format.
-- Additive only. A second, independent classifier alongside task_type: what
-- production format the work is (video / image / a live shoot / other).
-- Optional — not every task is content work, so it's nullable with no default.

alter table public.task
  add column if not exists content_format text
  check (content_format in ('video', 'image', 'shoot', 'other'));

create index if not exists task_content_format_idx on public.task(content_format);
