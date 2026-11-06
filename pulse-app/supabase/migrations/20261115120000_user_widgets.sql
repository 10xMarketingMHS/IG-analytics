-- Widgets (the sidebar's last item, pages/widgets.tsx): each person's own. Which
-- ones are on their break screen, and what they keep: their water count, note and
-- Pomodoro lengths (server/src/routes/widgets.js). Timers that are running stay in
-- the browser. Safe to run more than once.

create table if not exists public.user_widgets (
  user_id    uuid primary key references public.app_user(id) on delete cascade,
  picks      jsonb not null default '[]'::jsonb,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
