-- Team Chat voice messages: the recording behind each one, kept apart from
-- chat_message so a page of messages never carries the sound (it's fetched
-- when someone presses play). The message itself has an empty body.
-- After 30 days the sound is cleared to keep the database small
-- (server/src/routes/chat.js); the row stays, so the message still says it
-- was a voice message. Deleting the message removes its row. Safe to run more
-- than once.
create table if not exists public.chat_voice (
  message_id  uuid primary key references public.chat_message(id) on delete cascade,
  org_id      uuid not null references public.org(id) on delete cascade,
  mime        text not null,
  duration_ms integer not null check (duration_ms > 0 and duration_ms <= 130000),
  size_bytes  integer not null check (size_bytes > 0),
  audio       bytea,
  created_at  timestamptz not null default now()
);
-- the 30-day clear-out looks for old ones that still have their sound
create index if not exists chat_voice_old_idx on public.chat_voice(created_at) where audio is not null;
-- (20261031120000_rls_on: every table, this one too, closed to the public Data API)
alter table public.chat_voice enable row level security;
