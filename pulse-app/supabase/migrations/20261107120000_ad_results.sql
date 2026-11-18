-- Ads performance: each recorded ad's results (task_ad, 20261106120000_ad_uploads),
-- shown on the Ads performance page for everyone. VSL's come from Animus after
-- every spend sync; the other teams' are typed in by the Managers and Team
-- Leads, as in their "Ads Tracker" sheet. Shown only: no goal, points or
-- Leaderboard counts them. One statement, safe to run more than once.
alter table public.task_ad
  add column if not exists published_on   date,
  add column if not exists ad_status      text,
  add column if not exists hook_rate      numeric,
  add column if not exists hold_rate      numeric,
  add column if not exists leads          int,
  add column if not exists conversions    int,
  add column if not exists roas           numeric,
  add column if not exists spend          numeric,
  add column if not exists revenue        numeric,
  add column if not exists impressions    bigint,
  add column if not exists opt_ins        int,
  add column if not exists score          int,
  add column if not exists notes          text,
  -- animus (sent after each sync) or manual (typed in), when, and by whom
  add column if not exists results_source text,
  add column if not exists results_at     timestamptz,
  add column if not exists results_by     uuid references public.app_user(id) on delete set null;
