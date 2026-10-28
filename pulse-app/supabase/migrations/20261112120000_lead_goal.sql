-- Lead goals (Goals › Lead goals, server/src/routes/lead-goals.js): a Team
-- Lead's key results for a month — 200 L1 Conversions, 500 Leads, 50,000
-- Followers — that the team delivers and the lead answers for. Not part of
-- anyone's task score. A count is typed in at each Tactical meeting, for
-- Review 1 (1–15) and Review 2 (16–month end); Followers is read from the
-- connected social accounts. Safe to run more than once.

create table if not exists public.lead_goal (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.org(id) on delete cascade,
  period_month  date not null,
  editor_id     uuid not null references public.editor(id) on delete cascade,
  name          text not null,
  kind          text not null default 'count' check (kind in ('count', 'followers')),
  target        numeric not null check (target >= 0),
  r1_actual     numeric check (r1_actual >= 0),
  r2_actual     numeric check (r2_actual >= 0),
  sort_order    int not null default 0,
  updated_by    uuid references public.app_user(id) on delete set null,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists lead_goal_month_idx on public.lead_goal (org_id, period_month, editor_id);
