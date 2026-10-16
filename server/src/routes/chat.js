import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { isOrgAdmin } from "../permissions.js";

// Team chat — channels, direct messages, threads, reactions, @mentions and task
// links (see the team_chat migration). Everyone who works in the org (an admin or
// editor login) can chat; viewers can't, since a viewer may be someone outside
// the team. Public channels are readable by the whole team; DMs and private
// channels only by their members — admins get no back door into them.
//
// Live updates go out over one Server-Sent Events stream per open tab
// (GET /chat/stream). Every change is also readable over plain requests, so a
// tab that missed events (a dropped connection, a deploy) catches up by
// refetching when it reconnects.
export const chatRouter = Router();

const Uuid = z.string().uuid();
const MAX_BODY = 4000;
const DM_MAX_PEOPLE = 8;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// The team: active logins with an admin or editor role in any of the org's
// brands. Cached briefly, since every chat request checks it; someone added or
// removed shows up within the TTL.
const peopleCache = new Map(); // orgId -> { rows, byId, exp }
async function orgPeople(orgId) {
  const hit = peopleCache.get(orgId);
  if (hit && hit.exp > Date.now()) return hit;
  const { rows } = await pool.query(
    `select distinct on (u.id) u.id,
            coalesce(nullif(trim(u.name), ''), e.name, split_part(u.email, '@', 1)) as name,
            coalesce(u.image_url, e.image_url) as image_url, u.color,
            coalesce(e.designation, '') as designation
       from app_user u
       join membership m on m.user_id = u.id and m.role in ('admin', 'editor')
       join workspace w on w.id = m.workspace_id and w.org_id = $1
       left join editor e on e.id = u.editor_id
      where u.active
      order by u.id`,
    [orgId],
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const entry = { rows, byId: new Map(rows.map((p) => [p.id, p])), exp: Date.now() + 30_000 };
  peopleCache.set(orgId, entry);
  return entry;
}

chatRouter.use("/chat", async (req, res, next) => {
  try {
    const { byId } = await orgPeople(req.orgId);
    if (!byId.has(req.user.sub)) {
      return res.status(403).json({ error: "Team chat is for admins and editors." });
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Admins and Team Leads make channels. Designation is free text (Settings →
// Team, e.g. "Team Lead – Video Editor"), so it's matched loosely; a Manager
// sits above a Team Lead and counts too.
async function canCreateChannel(req) {
  if (await isOrgAdmin(req.orgId, req.user.sub)) return true;
  const { rows } = await pool.query(
    "select e.designation from app_user u join editor e on e.id = u.editor_id where u.id = $1",
    [req.user.sub],
  );
  const d = (rows[0]?.designation ?? "").toLowerCase();
  return d.includes("team lead") || d.includes("manager");
}

// Whoever made a channel, or an admin, can rename, re-topic or archive it.
async function canManageChannel(req, channel) {
  return channel.created_by === req.user.sub || (await isOrgAdmin(req.orgId, req.user.sub));
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

const streams = new Map(); // userId -> Set<{ res, orgId }>

function send(userId, event) {
  const set = streams.get(userId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const s of set) s.res.write(frame);
}

function onlineIn(orgId) {
  const ids = [];
  for (const [userId, set] of streams) {
    for (const s of set) if (s.orgId === orgId) { ids.push(userId); break; }
  }
  return ids;
}

function sendToOrg(orgId, event) {
  for (const userId of onlineIn(orgId)) send(userId, event);
}

async function memberIds(channelId) {
  const { rows } = await pool.query("select user_id from chat_member where channel_id = $1", [channelId]);
  return rows.map((r) => r.user_id);
}

// Tell everyone in a conversation (plus anyone named in `extra`, e.g. people
// @mentioned in a public channel they haven't joined).
async function notifyChannel(channelId, event, extra = []) {
  const ids = new Set([...(await memberIds(channelId)), ...extra]);
  for (const id of ids) send(id, event);
}

chatRouter.get("/chat/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");

  const me = req.user.sub;
  const entry = { res, orgId: req.orgId };
  const wasOnline = (streams.get(me)?.size ?? 0) > 0;
  if (!streams.has(me)) streams.set(me, new Set());
  streams.get(me).add(entry);
  if (!wasOnline) sendToOrg(req.orgId, { type: "presence", userId: me, online: true });

  // Proxies drop a silent connection; a comment line every 25s keeps it open.
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    const set = streams.get(me);
    set?.delete(entry);
    if (set && set.size === 0) {
      streams.delete(me);
      sendToOrg(req.orgId, { type: "presence", userId: me, online: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

// #general always exists and everyone is in it — the one channel nobody has to
// be added to. Made on first use, joined on every load (a no-op once in).
async function ensureGeneral(req) {
  await pool.query(
    `insert into chat_channel (org_id, kind, name, topic)
     values ($1, 'channel', 'general', 'Everyone on the team')
     on conflict (org_id, lower(name)) where kind = 'channel' do nothing`,
    [req.orgId],
  );
  await pool.query(
    `insert into chat_member (channel_id, user_id)
     select id, $2 from chat_channel where org_id = $1 and kind = 'channel' and lower(name) = 'general'
     on conflict do nothing`,
    [req.orgId, req.user.sub],
  );
}

const isGeneral = (c) => c.kind === "channel" && c.name.toLowerCase() === "general";

// Every conversation the caller can see — the ones they're in, plus public
// channels they could join — with what's unread in each. Unread counts only
// top-level messages (thread replies are announced to the thread instead);
// mentions count anywhere, replies included.
async function listChannels(orgId, me) {
  const { rows } = await pool.query(
    `select c.id, c.kind, c.name, c.topic, c.is_private, c.created_by, c.created_at, c.last_message_at,
            cm.user_id is not null as joined, cm.last_read_at,
            coalesce((select array_agg(x.user_id) from chat_member x where x.channel_id = c.id), '{}') as member_ids,
            case when cm.user_id is null then 0 else (
              select count(*)::int from chat_message m
               where m.channel_id = c.id and m.parent_id is null and m.deleted_at is null
                 and m.author_id is distinct from $2
                 and m.created_at > coalesce(cm.last_read_at, cm.joined_at)) end as unread,
            case when cm.user_id is null then 0 else (
              select count(*)::int from chat_message m
               where m.channel_id = c.id and m.deleted_at is null
                 and m.author_id is distinct from $2 and $2 = any(m.mentions)
                 and m.created_at > coalesce(cm.last_read_at, cm.joined_at)) end as mentions
       from chat_channel c
       left join chat_member cm on cm.channel_id = c.id and cm.user_id = $2
      where c.org_id = $1 and c.archived_at is null
        and (cm.user_id is not null or (c.kind = 'channel' and not c.is_private))
      order by c.kind, lower(c.name), c.last_message_at desc nulls last`,
    [orgId, me],
  );
  return rows;
}

// The conversation, if the caller may read it: a member, or anyone on the team
// for a public channel. Null otherwise (callers answer 404 — a private
// conversation's existence isn't confirmed to outsiders).
async function visibleChannel(req, channelId) {
  if (!Uuid.safeParse(channelId).success) return null;
  const { rows } = await pool.query(
    `select c.*, cm.user_id is not null as joined
       from chat_channel c
       left join chat_member cm on cm.channel_id = c.id and cm.user_id = $3
      where c.id = $1 and c.org_id = $2`,
    [channelId, req.orgId, req.user.sub],
  );
  const c = rows[0];
  if (!c) return null;
  if (!c.joined && (c.kind === "dm" || c.is_private)) return null;
  return c;
}

chatRouter.get("/chat/state", async (req, res, next) => {
  try {
    await ensureGeneral(req);
    const { rows: people } = await orgPeople(req.orgId);
    const channels = await listChannels(req.orgId, req.user.sub);
    res.json({
      me: req.user.sub,
      people,
      channels,
      canCreateChannel: await canCreateChannel(req),
      isAdmin: await isOrgAdmin(req.orgId, req.user.sub),
      online: onlineIn(req.orgId),
    });
  } catch (err) {
    next(err);
  }
});

const ChannelName = z
  .string()
  .transform((s) => s.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-"))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use up to 40 lowercase letters, numbers and dashes."));

const NewChannel = z.object({
  name: ChannelName,
  topic: z.string().trim().max(200).optional(),
  isPrivate: z.boolean().optional(),
  everyone: z.boolean().optional(),
  memberIds: z.array(Uuid).max(500).optional(),
});

chatRouter.post("/chat/channels", async (req, res, next) => {
  const parsed = NewChannel.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid channel" });
  const d = parsed.data;
  try {
    if (!(await canCreateChannel(req))) {
      return res.status(403).json({ error: "Only admins and team leads can create channels." });
    }
    const { rows: people, byId } = await orgPeople(req.orgId);
    const members = new Set([req.user.sub]);
    if (d.everyone && !d.isPrivate) people.forEach((p) => members.add(p.id));
    else (d.memberIds ?? []).filter((id) => byId.has(id)).forEach((id) => members.add(id));

    const client = await pool.connect();
    let channel;
    try {
      await client.query("begin");
      ({ rows: [channel] } = await client.query(
        `insert into chat_channel (org_id, kind, name, topic, is_private, created_by)
         values ($1, 'channel', $2, $3, $4, $5) returning *`,
        [req.orgId, d.name, d.topic ?? "", !!d.isPrivate, req.user.sub],
      ));
      await client.query(
        "insert into chat_member (channel_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing",
        [channel.id, [...members]],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      if (err.code === "23505") return res.status(409).json({ error: `#${d.name} already exists.` });
      throw err;
    } finally {
      client.release();
    }
    // A public channel shows in everyone's "browse" list, so tell the whole team.
    if (channel.is_private) for (const id of members) send(id, { type: "channels" });
    else sendToOrg(req.orgId, { type: "channels" });
    res.status(201).json({ channelId: channel.id });
  } catch (err) {
    next(err);
  }
});

const ChannelPatch = z.object({
  name: ChannelName.optional(),
  topic: z.string().trim().max(200).optional(),
  archived: z.boolean().optional(),
});

chatRouter.patch("/chat/channels/:id", async (req, res, next) => {
  const parsed = ChannelPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid change" });
  const d = parsed.data;
  try {
    const c = await visibleChannel(req, req.params.id);
    if (!c || c.kind !== "channel") return res.status(404).json({ error: "Channel not found" });
    if (!(await canManageChannel(req, c))) {
      return res.status(403).json({ error: "Only whoever made this channel, or an admin, can change it." });
    }
    if (isGeneral(c) && (d.name !== undefined || d.archived)) {
      return res.status(400).json({ error: "#general can't be renamed or archived." });
    }
    try {
      await pool.query(
        `update chat_channel set
           name = coalesce($2, name),
           topic = coalesce($3, topic),
           archived_at = case when $4::boolean is null then archived_at when $4 then now() else null end
         where id = $1`,
        [c.id, d.name ?? null, d.topic ?? null, d.archived ?? null],
      );
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: `#${d.name} already exists.` });
      throw err;
    }
    if (c.is_private) await notifyChannel(c.id, { type: "channels" });
    else sendToOrg(req.orgId, { type: "channels" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

chatRouter.post("/chat/channels/:id/join", async (req, res, next) => {
  try {
    const c = await visibleChannel(req, req.params.id);
    if (!c || c.kind !== "channel" || c.archived_at) return res.status(404).json({ error: "Channel not found" });
    await pool.query("insert into chat_member (channel_id, user_id) values ($1, $2) on conflict do nothing", [c.id, req.user.sub]);
    await notifyChannel(c.id, { type: "channels" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

chatRouter.post("/chat/channels/:id/leave", async (req, res, next) => {
  try {
    const c = await visibleChannel(req, req.params.id);
    if (!c || c.kind !== "channel") return res.status(404).json({ error: "Channel not found" });
    if (isGeneral(c)) return res.status(400).json({ error: "Everyone stays in #general." });
    await pool.query("delete from chat_member where channel_id = $1 and user_id = $2", [c.id, req.user.sub]);
    send(req.user.sub, { type: "channels" });
    await notifyChannel(c.id, { type: "channels" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

chatRouter.post("/chat/channels/:id/members", async (req, res, next) => {
  const parsed = z.object({ userIds: z.array(Uuid).min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pick at least one person." });
  try {
    const c = await visibleChannel(req, req.params.id);
    if (!c || c.kind !== "channel" || c.archived_at) return res.status(404).json({ error: "Channel not found" });
    if (!c.joined) return res.status(403).json({ error: "Join the channel first." });
    const { byId } = await orgPeople(req.orgId);
    const ids = parsed.data.userIds.filter((id) => byId.has(id));
    await pool.query(
      "insert into chat_member (channel_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing",
      [c.id, ids],
    );
    await notifyChannel(c.id, { type: "channels" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Open a direct message with one or more people (a group DM past one). The same
// set of people always gets the same conversation back.
chatRouter.post("/chat/dm", async (req, res, next) => {
  const parsed = z.object({ userIds: z.array(Uuid).min(1).max(DM_MAX_PEOPLE - 1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `Pick between 1 and ${DM_MAX_PEOPLE - 1} people.` });
  try {
    const { byId } = await orgPeople(req.orgId);
    const others = [...new Set(parsed.data.userIds)].filter((id) => id !== req.user.sub);
    if (!others.length || others.some((id) => !byId.has(id))) {
      return res.status(400).json({ error: "Pick people from the team." });
    }
    const members = [req.user.sub, ...others].sort();
    const key = members.join(",");
    await pool.query(
      `insert into chat_channel (org_id, kind, dm_key, created_by) values ($1, 'dm', $2, $3)
       on conflict (org_id, dm_key) where kind = 'dm' do nothing`,
      [req.orgId, key, req.user.sub],
    );
    const { rows: [c] } = await pool.query(
      "select id from chat_channel where org_id = $1 and kind = 'dm' and dm_key = $2",
      [req.orgId, key],
    );
    await pool.query(
      "insert into chat_member (channel_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing",
      [c.id, members],
    );
    send(req.user.sub, { type: "channels" });
    res.json({ channelId: c.id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MENTION_RE = /<@([0-9a-f-]{36})>/g;
const TASK_RE = /<task:([0-9a-f-]{36})>/g;

// The people and tasks a message points at, kept only when they're real
// members of this org — a forged id never reaches the stored lists.
async function refsIn(orgId, body) {
  const { byId } = await orgPeople(orgId);
  const mentions = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]))].filter((id) => byId.has(id));
  const wanted = [...new Set([...body.matchAll(TASK_RE)].map((m) => m[1]))];
  let taskIds = [];
  if (wanted.length) {
    const { rows } = await pool.query("select id from task where org_id = $1 and id = any($2::uuid[])", [orgId, wanted]);
    taskIds = rows.map((r) => r.id);
  }
  return { mentions, taskIds };
}

// What a task link shows: enough for a card (title, number, status, who's on it,
// brand, due date). Tasks are visible to the whole team, so no extra gate.
async function taskSummaries(orgId, ids) {
  if (!ids.length) return {};
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.task_type, t.tid, t.sid, t.ad_id, t.svid, t.pid, t.due_date,
            e.name as editor_name, w.name as channel_name
       from task t
       left join editor e on e.id = t.editor_id
       left join workspace w on w.id = t.channel_id
      where t.org_id = $1 and t.id = any($2::uuid[])`,
    [orgId, ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

// Messages as the client wants them: reactions grouped by emoji, the first few
// people who replied in each thread, and a card for every linked task. A
// deleted message keeps its place (and thread) but loses its content.
async function hydrate(orgId, rows) {
  if (!rows.length) return { messages: [], tasks: {} };
  const ids = rows.map((r) => r.id);
  const { rows: reacts } = await pool.query(
    `select message_id, emoji, array_agg(user_id order by created_at) as user_ids
       from chat_reaction where message_id = any($1::uuid[])
      group by message_id, emoji
      order by min(created_at)`,
    [ids],
  );
  const reactionsOf = new Map();
  for (const r of reacts) {
    if (!reactionsOf.has(r.message_id)) reactionsOf.set(r.message_id, []);
    reactionsOf.get(r.message_id).push({ emoji: r.emoji, userIds: r.user_ids });
  }
  const threads = rows.filter((r) => r.reply_count > 0).map((r) => r.id);
  const repliersOf = new Map();
  if (threads.length) {
    const { rows: rep } = await pool.query(
      `select parent_id, array_agg(author_id order by last_at desc) as ids
         from (select parent_id, author_id, max(created_at) as last_at from chat_message
                where parent_id = any($1::uuid[]) and author_id is not null and deleted_at is null
                group by parent_id, author_id) x
        group by parent_id`,
      [threads],
    );
    for (const r of rep) repliersOf.set(r.parent_id, r.ids.slice(0, 3));
  }
  const tasks = await taskSummaries(orgId, [...new Set(rows.flatMap((r) => (r.deleted_at ? [] : r.task_ids)))]);
  const messages = rows.map((r) => {
    const deleted = !!r.deleted_at;
    return {
      id: r.id,
      channelId: r.channel_id,
      parentId: r.parent_id,
      authorId: r.author_id,
      body: deleted ? "" : r.body,
      mentions: deleted ? [] : r.mentions,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deleted,
      replyCount: r.reply_count,
      lastReplyAt: r.last_reply_at,
      replyUserIds: repliersOf.get(r.id) ?? [],
      reactions: deleted ? [] : reactionsOf.get(r.id) ?? [],
    };
  });
  return { messages, tasks };
}

async function messageRow(id) {
  if (!Uuid.safeParse(id).success) return null;
  const { rows } = await pool.query("select * from chat_message where id = $1", [id]);
  return rows[0] ?? null;
}

// Someone @mentioned in a public channel they haven't joined still hears about
// it. In a DM or private channel they're not in, they hear nothing — the
// mention can't carry the conversation out to them.
function mentionedOutsiders(channel, mentions) {
  return channel.kind === "channel" && !channel.is_private ? mentions : [];
}

// Push a message (new or changed) to everyone it concerns.
async function broadcastMessage(orgId, row, { isNew = false, extra = [] } = {}) {
  const { messages, tasks } = await hydrate(orgId, [row]);
  const event = { type: "message", isNew, message: messages[0], tasks };
  if (isNew && row.parent_id) {
    // Everyone in the thread so far, so a reply can be announced to them.
    const { rows } = await pool.query(
      "select distinct author_id from chat_message where (id = $1 or parent_id = $1) and author_id is not null",
      [row.parent_id],
    );
    event.threadUserIds = rows.map((r) => r.author_id);
  }
  await notifyChannel(row.channel_id, event, extra);
  return { message: messages[0], tasks };
}

// Top-level messages, newest page first: `before` is a message id to page back
// from (the oldest one already on screen).
chatRouter.get("/chat/channels/:id/messages", async (req, res, next) => {
  try {
    const c = await visibleChannel(req, req.params.id);
    if (!c) return res.status(404).json({ error: "Conversation not found" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before && Uuid.safeParse(req.query.before).success ? req.query.before : null;
    const { rows } = await pool.query(
      `select * from chat_message
        where channel_id = $1 and parent_id is null
          and ($2::uuid is null or created_at < (select created_at from chat_message where id = $2))
        order by created_at desc
        limit $3`,
      [c.id, before, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    res.json({ ...(await hydrate(req.orgId, page)), hasMore });
  } catch (err) {
    next(err);
  }
});

chatRouter.get("/chat/messages/:id/thread", async (req, res, next) => {
  try {
    const parent = await messageRow(req.params.id);
    if (!parent || parent.parent_id || !(await visibleChannel(req, parent.channel_id))) {
      return res.status(404).json({ error: "Thread not found" });
    }
    const { rows } = await pool.query(
      "select * from chat_message where parent_id = $1 order by created_at asc limit 1000",
      [parent.id],
    );
    const { messages, tasks } = await hydrate(req.orgId, [parent, ...rows]);
    res.json({ parent: messages[0], replies: messages.slice(1), tasks });
  } catch (err) {
    next(err);
  }
});

const NewMessage = z.object({
  body: z.string().trim().min(1, "Write something first.").max(MAX_BODY, `Keep it under ${MAX_BODY} characters.`),
  parentId: Uuid.optional(),
});

chatRouter.post("/chat/channels/:id/messages", async (req, res, next) => {
  const parsed = NewMessage.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid message" });
  const { body, parentId } = parsed.data;
  try {
    const c = await visibleChannel(req, req.params.id);
    if (!c) return res.status(404).json({ error: "Conversation not found" });
    if (c.archived_at) return res.status(400).json({ error: "This channel is archived." });
    if (parentId) {
      const parent = await messageRow(parentId);
      if (!parent || parent.channel_id !== c.id || parent.parent_id) {
        return res.status(400).json({ error: "That thread isn't in this conversation." });
      }
    }
    const { mentions, taskIds } = await refsIn(req.orgId, body);

    const client = await pool.connect();
    let row;
    try {
      await client.query("begin");
      // Posting in a public channel you're only browsing joins it.
      await client.query(
        "insert into chat_member (channel_id, user_id) values ($1, $2) on conflict do nothing",
        [c.id, req.user.sub],
      );
      ({ rows: [row] } = await client.query(
        `insert into chat_message (org_id, channel_id, parent_id, author_id, body, mentions, task_ids)
         values ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[]) returning *`,
        [req.orgId, c.id, parentId ?? null, req.user.sub, body, mentions, taskIds],
      ));
      if (parentId) {
        await client.query(
          "update chat_message set reply_count = reply_count + 1, last_reply_at = $2 where id = $1",
          [parentId, row.created_at],
        );
      } else {
        await client.query("update chat_channel set last_message_at = $2 where id = $1", [c.id, row.created_at]);
        // Your own message is read by you.
        await client.query(
          `update chat_member set last_read_at = greatest(coalesce(last_read_at, '-infinity'), $3)
            where channel_id = $1 and user_id = $2`,
          [c.id, req.user.sub, row.created_at],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    if (!c.joined) await notifyChannel(c.id, { type: "channels" });
    const out = await broadcastMessage(req.orgId, row, { isNew: true, extra: mentionedOutsiders(c, mentions) });
    if (parentId) await broadcastMessage(req.orgId, await messageRow(parentId));
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

chatRouter.patch("/chat/messages/:id", async (req, res, next) => {
  const parsed = NewMessage.pick({ body: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid message" });
  try {
    const row = await messageRow(req.params.id);
    const c = row && !row.deleted_at && (await visibleChannel(req, row.channel_id));
    if (!c) return res.status(404).json({ error: "Message not found" });
    if (row.author_id !== req.user.sub) return res.status(403).json({ error: "You can only edit your own messages." });
    const { mentions, taskIds } = await refsIn(req.orgId, parsed.data.body);
    const { rows: [updated] } = await pool.query(
      `update chat_message set body = $2, mentions = $3::uuid[], task_ids = $4::uuid[], edited_at = now()
        where id = $1 returning *`,
      [row.id, parsed.data.body, mentions, taskIds],
    );
    res.json(await broadcastMessage(req.orgId, updated, { extra: mentionedOutsiders(c, mentions) }));
  } catch (err) {
    next(err);
  }
});

// Delete your own message — or, in a channel, an admin can remove anyone's.
// DMs stay between their members, so an admin never reaches into one.
chatRouter.delete("/chat/messages/:id", async (req, res, next) => {
  try {
    const row = await messageRow(req.params.id);
    const c = row && (await visibleChannel(req, row.channel_id));
    if (!row || row.deleted_at || !c) return res.status(404).json({ error: "Message not found" });
    const mine = row.author_id === req.user.sub;
    if (!mine && !(c.kind === "channel" && (await isOrgAdmin(req.orgId, req.user.sub)))) {
      return res.status(403).json({ error: "You can only delete your own messages." });
    }
    await pool.query("delete from chat_reaction where message_id = $1", [row.id]);
    const { rows: [deleted] } = await pool.query(
      `update chat_message set deleted_at = now(), body = '', mentions = '{}', task_ids = '{}'
        where id = $1 returning *`,
      [row.id],
    );
    await broadcastMessage(req.orgId, deleted);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Toggle one emoji reaction of yours on a message.
chatRouter.post("/chat/messages/:id/reactions", async (req, res, next) => {
  const parsed = z.object({ emoji: z.string().min(1).max(16).regex(/^\S+$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pick an emoji." });
  try {
    const row = await messageRow(req.params.id);
    if (!row || row.deleted_at || !(await visibleChannel(req, row.channel_id))) {
      return res.status(404).json({ error: "Message not found" });
    }
    const { rowCount } = await pool.query(
      "delete from chat_reaction where message_id = $1 and user_id = $2 and emoji = $3",
      [row.id, req.user.sub, parsed.data.emoji],
    );
    if (!rowCount) {
      await pool.query(
        "insert into chat_reaction (message_id, user_id, emoji) values ($1, $2, $3) on conflict do nothing",
        [row.id, req.user.sub, parsed.data.emoji],
      );
    }
    res.json(await broadcastMessage(req.orgId, row));
  } catch (err) {
    next(err);
  }
});

// Mark a conversation read up to a message. Takes the message's id rather than
// a timestamp so the database's own (microsecond) created_at is what's stored —
// a browser's millisecond copy would leave that message counted as unread.
chatRouter.post("/chat/channels/:id/read", async (req, res, next) => {
  const parsed = z.object({ messageId: Uuid }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Which message?" });
  if (!Uuid.safeParse(req.params.id).success) return res.status(404).json({ error: "Conversation not found" });
  try {
    const { rowCount } = await pool.query(
      `update chat_member cm
          set last_read_at = greatest(coalesce(cm.last_read_at, '-infinity'), m.created_at)
         from chat_message m
        where m.id = $3 and m.channel_id = $1 and cm.channel_id = $1 and cm.user_id = $2`,
      [req.params.id, req.user.sub, parsed.data.messageId],
    );
    if (rowCount) send(req.user.sub, { type: "read", channelId: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
