-- Team Chat, more of what Slack has: each person's starred and muted
-- conversations, messages pinned to a conversation (for everyone in it), and
-- each person's saved messages. Search, typing, drafts and @channel / @here
-- need nothing new here. Safe to run more than once.

-- Starred: listed first. Muted: no unread badge or notice, except when you're
-- @mentioned by name. Both are your own (one row per person per conversation).
alter table public.chat_member add column if not exists starred boolean not null default false;
alter table public.chat_member add column if not exists muted boolean not null default false;

-- Pinned: kept at the top of the conversation's pins for everyone in it.
alter table public.chat_message add column if not exists pinned_at timestamptz;
alter table public.chat_message add column if not exists pinned_by uuid references public.app_user(id) on delete set null;
create index if not exists chat_message_pinned_idx on public.chat_message(channel_id, pinned_at desc) where pinned_at is not null;

-- Saved for later: only yours, and only while you can still read the message.
create table if not exists public.chat_saved (
  user_id    uuid not null references public.app_user(id) on delete cascade,
  message_id uuid not null references public.chat_message(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
-- (20261031120000_rls_on: every table, this one too, closed to the public Data API)
alter table public.chat_saved enable row level security;
