-- Content formats become CATEGORY-scoped (Social vs Ads).
--
-- Until now task_content_format was one flat org-wide list (Video/Image/Shoot/
-- Other). Product decision: Social and Ads each have their own content types,
-- each with its own points and time budget. A format now belongs to exactly one
-- category, and the task-creation Content Type dropdown pulls the chosen
-- category's formats — so picking one drives the task's score + timer.
--
-- The old flat defaults are retired (kept inactive so any task/rule already on
-- them still resolves its name/icon), and every org is seeded with the
-- per-category content types that match the Social/Ads task-creation flow.

alter table public.task_content_format
  add column if not exists category text check (category in ('social', 'ad'));

-- Uniqueness is now per category among active formats (Social and Ads may each
-- legitimately hold a same-named type; retired rows never collide).
alter table public.task_content_format drop constraint if exists task_content_format_org_id_name_key;
create unique index if not exists task_content_format_org_cat_name_uq
  on public.task_content_format(org_id, category, name) where active;

-- Retire the old flat defaults.
update public.task_content_format
   set active = false
 where category is null and name in ('Video', 'Image', 'Shoot', 'Other');

-- Seed the per-category content types for every org (points default 1, so
-- nothing scores 0 before an admin sets real values).
insert into public.task_content_format (org_id, name, icon, sort_order, category, points)
select o.id, v.name, v.icon, v.sort_order, v.category, 1
  from public.org o
  cross join (values
    ('Reel',          '🎬', 1, 'social'),
    ('Carousel',      '🖼️', 2, 'social'),
    ('Thumbnail',     '🖼️', 3, 'social'),
    ('YouTube Video', '▶️', 4, 'social'),
    ('Ad Video',      '🎬', 1, 'ad')
  ) as v(name, icon, sort_order, category);
