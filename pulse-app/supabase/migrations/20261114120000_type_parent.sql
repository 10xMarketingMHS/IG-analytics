-- Sub-types (Settings › Tasks & time): a task type may sit under a main type of
-- the same category, as Video Carousel and Image Carousel under Carousel. Each
-- is still its own type, with its own points, time and goals, and the main type
-- is a type too; the lists fold the sub-types under it. One level only: a
-- sub-type has no sub-types (server/src/routes/content-formats.js). Removing a
-- main type leaves its sub-types on their own. Safe to run more than once.

alter table public.task_content_format add column if not exists parent_id uuid references public.task_content_format(id) on delete set null;
create index if not exists task_content_format_parent_idx on public.task_content_format(parent_id);
