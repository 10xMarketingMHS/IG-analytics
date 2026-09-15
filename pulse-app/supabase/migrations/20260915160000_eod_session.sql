-- Start/End EOD — one clock-in session per editor per workday.
--
-- Gates the whole app for editors: no open session ⇒ the app is blocked behind a
-- Start EOD screen (enforced again server-side on task-mutation routes). A
-- session ends only via an explicit End EOD — never auto-closed at midnight or
-- any boundary — so `date` is captured once from started_at and never
-- recomputed, and there's deliberately no "forced/auto closed" flag.
create table public.eod_session (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.org(id) on delete cascade,
  editor_id  uuid not null references public.editor(id) on delete cascade,
  date       date not null,                 -- attributed workday (from started_at, fixed)
  started_at timestamptz not null default now(),
  ended_at   timestamptz                    -- null ⇒ currently active
);

-- At most one OPEN session per editor — makes Start EOD idempotent under a
-- double-click / race (a second insert violates this and is treated as a no-op).
create unique index eod_session_one_open_uq on public.eod_session(editor_id) where ended_at is null;
-- Fast "today's session for this editor" and history lookups.
create index eod_session_editor_date_idx on public.eod_session(editor_id, date);
