-- Brand goals (Goals › Brand goals, server/src/routes/brand-goals.js): how many
-- jobs of each task type a brand needs in a month — Doctor Farmer 30 Reels, My
-- Health School 30 Reels — and, for Ads, each Ads team (Ad tasks are made for a
-- team). Set goals then shows how much of each type is still to give out to the
-- team. They don't change anyone's score. One row per month, type and brand (or
-- Ads team). Safe to run more than once.

create table if not exists public.brand_goal (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.org(id) on delete cascade,
  period_month      date not null,
  content_format_id uuid not null references public.task_content_format(id) on delete cascade,
  channel_id        uuid references public.workspace(id) on delete cascade,
  ad_team_id        uuid references public.ad_team(id) on delete cascade,
  jobs              int not null check (jobs >= 0),
  updated_by        uuid references public.app_user(id) on delete set null,
  updated_at        timestamptz not null default now(),
  check ((channel_id is null) <> (ad_team_id is null))
);

create unique index if not exists brand_goal_uq on public.brand_goal (org_id, period_month, content_format_id, (coalesce(channel_id, ad_team_id)));

create index if not exists brand_goal_month_idx on public.brand_goal (org_id, period_month);
