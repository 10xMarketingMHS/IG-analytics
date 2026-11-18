-- Team chat — channels, direct messages, threads and reactions.
--
-- A conversation is a chat_channel: kind 'channel' is a named room (#general,
-- #design…), public to the whole org unless is_private; kind 'dm' is a private
-- chat between two or more people, found again by dm_key (its members' ids,
-- sorted and joined) so the same people always land in the same DM. Nobody
-- outside a DM or a private channel can read it — admins included.
create table if not exists public.chat_channel (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.org(id) on delete cascade,
  kind            text not null check (kind in ('channel', 'dm')),
  name            text,
  topic           text not null default '',
  is_private      boolean not null default false,
  dm_key          text,
  created_by      uuid references public.app_user(id) on delete set null,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  last_message_at timestamptz,
  check ((kind = 'channel') = (name is not null)),
  check ((kind = 'dm') = (dm_key is not null))
);

create unique index if not exists chat_channel_name_uq on public.chat_channel(org_id, lower(name)) where kind = 'channel';
create unique index if not exists chat_channel_dm_uq on public.chat_channel(org_id, dm_key) where kind = 'dm';

-- Who's in a conversation, and how far they've read. last_read_at is the
-- created_at of the newest message they've seen; anything after it is unread.
create table if not exists public.chat_member (
  channel_id   uuid not null references public.chat_channel(id) on delete cascade,
  user_id      uuid not null references public.app_user(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (channel_id, user_id)
);

create index if not exists chat_member_user_idx on public.chat_member(user_id);

-- A message, or (parent_id set) a reply in a message's thread. Mentions and
-- task links are written into the body as <@user-id> and <task:task-id>;
-- `mentions` and `task_ids` hold the same ids for lookups. A deleted message
-- keeps its row (so its thread survives) with the body cleared.
create table if not exists public.chat_message (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.org(id) on delete cascade,
  channel_id    uuid not null references public.chat_channel(id) on delete cascade,
  parent_id     uuid references public.chat_message(id) on delete cascade,
  author_id     uuid references public.app_user(id) on delete set null,
  body          text not null,
  mentions      uuid[] not null default '{}',
  task_ids      uuid[] not null default '{}',
  created_at    timestamptz not null default now(),
  edited_at     timestamptz,
  deleted_at    timestamptz,
  reply_count   integer not null default 0,
  last_reply_at timestamptz
);

create index if not exists chat_message_channel_idx on public.chat_message(channel_id, created_at) where parent_id is null;
create index if not exists chat_message_thread_idx on public.chat_message(parent_id, created_at) where parent_id is not null;
create index if not exists chat_message_mentions_idx on public.chat_message using gin (mentions);

create table if not exists public.chat_reaction (
  message_id uuid not null references public.chat_message(id) on delete cascade,
  user_id    uuid not null references public.app_user(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
