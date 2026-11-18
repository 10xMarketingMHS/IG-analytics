-- Each post's numbers, day by day — so Analytics can count views as they came
-- in: a reel posted in January that takes off in September shows in September.
-- The server writes one row per post per day (India time) whenever a sync or a
-- typed-in edit leaves its totals changed (server/src/post-history.js). The
-- last 90 days are kept day by day; older days are thinned to one row a week
-- (each week's last). Today's totals of every published post are the starting
-- point. Safe to run more than once.

create table if not exists public.post_metric_day (
  post_id  uuid not null references public.post(id) on delete cascade,
  day      date not null,
  views    bigint,
  reach    bigint,
  likes    bigint,
  comments bigint,
  shares   bigint,
  saves    bigint,
  primary key (post_id, day)
);

create index if not exists post_metric_day_day_idx on public.post_metric_day(day);

insert into public.post_metric_day (post_id, day, views, reach, likes, comments, shares, saves)
select id, (now() at time zone 'Asia/Kolkata')::date, views, reach, likes, comments, shares, saves
  from public.post
 where deleted_at is null and status = 'published'
on conflict (post_id, day) do nothing;
