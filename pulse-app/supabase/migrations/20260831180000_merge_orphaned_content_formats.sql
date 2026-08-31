-- Merge formats orphaned by the Social/Ads category split.
--
-- 20260828140000_content_format_category.sql only retired the app's original
-- flat defaults ('Video','Image','Shoot','Other'). Orgs that had already
-- renamed/added their own formats before that migration ran (this one has:
-- Reels, Podcast, Ad video, YouTube video) were left with category = null —
-- invisible in the new Social/Ads-scoped Task Settings UI and unselectable
-- for new tasks, even though existing tasks still reference them fine.
--
-- Fix: give those pre-existing rows a category (so they're the same row
-- everyone already knows, with whatever points/hours were configured on
-- them) rather than leaving them stranded behind two freshly-seeded,
-- zero-usage near-duplicates ('Reel', 'Ad Video', 'YouTube Video'). Those
-- duplicates get deactivated instead — safe because nothing has used them
-- yet (checked: 0 tasks reference any of the three before running this).

update public.task_content_format
   set category = 'social'
 where category is null and active and name in ('Reels', 'Podcast', 'YouTube video');

update public.task_content_format
   set category = 'ad'
 where category is null and active and name = 'Ad video';

-- Deactivate the brand-new seeded duplicates this leaves redundant. Matched
-- by name only (case-sensitive, so 'Reels' above is untouched) and — as a
-- safety net in case some other org's already put these to real use — only
-- when nothing references them.
update public.task_content_format f
   set active = false
 where f.active
   and f.name in ('Reel', 'Ad Video', 'YouTube Video')
   and not exists (select 1 from public.task t where t.content_format_id = f.id);
