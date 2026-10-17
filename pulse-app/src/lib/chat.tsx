import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, API_BASE, ApiError } from "@/lib/api";
import { gradFor } from "@/lib/editor-visuals";
import type { TaskStatus, TaskType } from "@/lib/types";

// Team chat's shared layer, mounted once in the app shell: the conversation list
// with unread counts (the sidebar badge), who's online, and the one live stream
// (Server-Sent Events) per tab. The Chat page subscribes to its events; anywhere
// else in the app, a DM, an @mention or a reply in your thread pops a notice.

export type ChatPerson = {
  id: string;
  name: string;
  image_url: string | null;
  color: string | null;
  designation: string;
};

export type ChatChannel = {
  id: string;
  kind: "channel" | "dm";
  name: string | null;
  topic: string;
  is_private: boolean;
  created_by: string | null;
  created_at: string;
  last_message_at: string | null;
  joined: boolean;
  last_read_at: string | null;
  member_ids: string[];
  unread: number;
  mentions: number;
};

export type ChatReaction = { emoji: string; userIds: string[] };

export type ChatMessage = {
  id: string;
  channelId: string;
  parentId: string | null;
  authorId: string | null;
  body: string;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  replyUserIds: string[];
  reactions: ChatReaction[];
};

export type ChatTask = {
  id: string;
  title: string;
  status: TaskStatus;
  task_type: TaskType;
  tid: string | null;
  sid: string | null;
  ad_id: string | null;
  svid: string | null;
  pid: string | null;
  due_date: string | null;
  editor_id: string | null;
  editor_name: string | null;
  editor_image: string | null;
  channel_name: string | null;
  content_format_name: string | null;
  // For approving from the card: who handed it over, the work, the link rule.
  assigned_by: string | null;
  delivery_link: string | null;
  link_required: boolean;
  review_started_at: string | null;
  pending_note: string | null;
};

export type ChatEvent =
  | { type: "message"; isNew: boolean; message: ChatMessage; tasks: Record<string, ChatTask>; threadUserIds?: string[] }
  | { type: "channels" }
  | { type: "read"; channelId: string }
  | { type: "presence"; userId: string; online: boolean }
  // Not from the server: the stream came back after a drop, so anything open
  // should refetch what it may have missed.
  | { type: "resync" };

type ChatState = {
  me: string;
  people: ChatPerson[];
  channels: ChatChannel[];
  canCreateChannel: boolean;
  isAdmin: boolean;
  online: string[];
};

type Viewing = { channelId: string | null; threadId: string | null };

type ChatContextValue = {
  // False for anyone chat isn't for (viewers) — the sidebar hides the link.
  available: boolean;
  state: ChatState | null;
  people: Map<string, ChatPerson>;
  online: Set<string>;
  // alerts = @mentions + unread DMs (the red count); unread = other channel messages.
  totals: { alerts: number; unread: number };
  refresh: () => Promise<void>;
  subscribe: (fn: (e: ChatEvent) => void) => () => void;
  setViewing: (v: Viewing) => void;
  markRead: (channelId: string, messageId: string) => void;
};

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within a ChatProvider");
  return ctx;
}

// A DM is listed once it has a message, or if you opened it yourself — someone
// starting a DM with you and not writing yet shouldn't clutter your list.
export function dmVisible(c: ChatChannel, me: string) {
  return c.kind === "dm" && (!!c.last_message_at || c.created_by === me);
}

export function dmTitle(c: ChatChannel, people: Map<string, ChatPerson>, me: string) {
  const others = c.member_ids.filter((id) => id !== me).map((id) => people.get(id)?.name ?? "Someone");
  return others.length ? others.sort((a, b) => a.localeCompare(b)).join(", ") : "Just you";
}

export function channelTitle(c: ChatChannel, people: Map<string, ChatPerson>, me: string) {
  return c.kind === "dm" ? dmTitle(c, people, me) : `#${c.name}`;
}

// The number people know a task by: its brand's SID/AID/SVID/PID, else the TID.
export function taskLabel(t: Pick<ChatTask, "sid" | "ad_id" | "svid" | "pid" | "tid">) {
  return t.sid || t.ad_id?.replace(/^AdID/i, "AID") || t.svid || t.pid || t.tid || "Task";
}

// A message's body with its <@id> / <task:id> tokens spelled out — for
// notices and the edit box.
export function toPlain(body: string, people: Map<string, ChatPerson>, tasks: Record<string, ChatTask>) {
  return body
    .replace(/<@([0-9a-f-]{36})>/g, (_m, id) => `@${people.get(id)?.name ?? "someone"}`)
    .replace(/<task:([0-9a-f-]{36})>/g, (_m, id) => (tasks[id] ? `#${taskLabel(tasks[id])}` : "#task"));
}

// Solid colours dark enough for white initials (≥4.5:1), one per person by name.
const AVATAR_COLORS = ["#7c3aed", "#2563eb", "#0e7490", "#047857", "#b45309", "#be185d", "#4f46e5", "#0f766e", "#a21caf", "#c2410c"];
export function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
// "Priya Sharma" → "PS", "Priya" → "P".
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0]?.[0] ?? "?")).toUpperCase();
}

export function PersonAvatar({ person, name, size = 32, online }: { person?: ChatPerson; name?: string; size?: number; online?: boolean }) {
  const label = person?.name ?? name ?? "?";
  return (
    <span className="chat-ava" style={{ width: size, height: size, fontSize: Math.round(size * (initials(label).length > 1 ? 0.36 : 0.42)) }}>
      {person?.image_url ? (
        <img src={person.image_url} alt="" />
      ) : (
        <span className="chat-ava-in" style={{ background: person?.color || (person || name ? avatarColor(label) : gradFor(label)) }}>{initials(label)}</span>
      )}
      {online !== undefined && <span className={"chat-ava-dot" + (online ? " on" : "")} />}
    </span>
  );
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<ChatState | null>(null);
  const [available, setAvailable] = useState(true);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const listeners = useRef(new Set<(e: ChatEvent) => void>());
  const viewing = useRef<Viewing>({ channelId: null, threadId: null });
  const stateRef = useRef<ChatState | null>(null);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    try {
      const s = await api<ChatState>("/chat/state");
      setState(s);
      setOnline(new Set(s.online));
      setAvailable(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setAvailable(false);
    }
  }, []);

  // Several events can arrive in a burst (a channel made for everyone, a join);
  // one refetch covers them.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => refresh(), 300);
  }, [refresh]);

  const people = useMemo(() => new Map((state?.people ?? []).map((p) => [p.id, p])), [state?.people]);
  const peopleRef = useRef(people);
  peopleRef.current = people;

  const patchChannel = useCallback((id: string, fn: (c: ChatChannel) => ChatChannel) => {
    setState((s) => (s ? { ...s, channels: s.channels.map((c) => (c.id === id ? fn(c) : c)) } : s));
  }, []);

  const handle = useCallback((e: ChatEvent) => {
    const s = stateRef.current;
    if (e.type === "channels" || e.type === "read") refreshSoon();
    if (e.type === "presence") {
      setOnline((prev) => {
        const next = new Set(prev);
        if (e.online) next.add(e.userId); else next.delete(e.userId);
        return next;
      });
    }
    if (e.type === "message" && e.isNew && s && e.message.authorId !== s.me) {
      const m = e.message;
      const ch = s.channels.find((c) => c.id === m.channelId);
      if (!ch || !ch.joined) refreshSoon();
      const visible = document.visibilityState === "visible";
      const seeingChannel = visible && viewing.current.channelId === m.channelId;
      const seeingThread = visible && !!m.parentId && viewing.current.threadId === m.parentId;
      const mentionsMe = m.mentions.includes(s.me);
      if (ch && ch.joined) {
        patchChannel(ch.id, (c) => ({
          ...c,
          last_message_at: m.parentId ? c.last_message_at : m.createdAt,
          unread: !m.parentId && !seeingChannel ? c.unread + 1 : c.unread,
          mentions: mentionsMe && !(m.parentId ? seeingThread : seeingChannel) ? c.mentions + 1 : c.mentions,
        }));
      }
      const inMyThread = !!m.parentId && (e.threadUserIds ?? []).includes(s.me);
      const isDm = ch?.kind === "dm";
      const worthSaying = mentionsMe || (isDm && !m.parentId) || inMyThread;
      const alreadyThere = m.parentId ? seeingThread : seeingChannel;
      if (worthSaying && !alreadyThere) {
        const who = peopleRef.current.get(m.authorId ?? "")?.name ?? "Someone";
        const where = m.parentId ? "replied in a thread" : isDm ? "" : `in #${ch?.name ?? "a channel"}`;
        const text = toPlain(m.body, peopleRef.current, e.tasks);
        toast(`💬 ${who}${where ? " " + where : ""}`, {
          description: text.length > 140 ? text.slice(0, 140) + "…" : text,
          action: {
            label: "Open",
            onClick: () => navigate(`/chat?c=${m.channelId}${m.parentId ? `&t=${m.parentId}` : ""}`),
          },
        });
      }
    }
    listeners.current.forEach((fn) => fn(e));
  }, [navigate, patchChannel, refreshSoon]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The live stream, once we know chat is ours. EventSource reconnects by
  // itself; after a drop, refetch the list and tell the page to catch up.
  const hasState = !!state;
  useEffect(() => {
    if (!available || !hasState) return;
    const es = new EventSource(`${API_BASE}/chat/stream`, { withCredentials: true });
    let dropped = false;
    es.onmessage = (ev) => {
      try { handle(JSON.parse(ev.data)); } catch { /* ignore a malformed frame */ }
    };
    es.onerror = () => { dropped = true; };
    es.onopen = () => {
      if (!dropped) return;
      dropped = false;
      refresh();
      listeners.current.forEach((fn) => fn({ type: "resync" }));
    };
    return () => es.close();
  }, [available, hasState, handle, refresh]);

  // Belt and braces: counts drift if the stream misses something (a deploy, a
  // sleeping laptop), so re-read them now and then and whenever the tab returns.
  useEffect(() => {
    if (!available) return;
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [available, refresh]);

  const subscribe = useCallback((fn: (e: ChatEvent) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const setViewing = useCallback((v: Viewing) => { viewing.current = v; }, []);

  const markRead = useCallback((channelId: string, messageId: string) => {
    patchChannel(channelId, (c) => ({ ...c, unread: 0, mentions: 0 }));
    api(`/chat/channels/${channelId}/read`, { method: "POST", body: JSON.stringify({ messageId }) }).catch(() => {});
  }, [patchChannel]);

  const totals = useMemo(() => {
    let alerts = 0;
    let unread = 0;
    for (const c of state?.channels ?? []) {
      if (!c.joined) continue;
      alerts += c.mentions;
      if (c.kind === "dm") alerts += Math.max(c.unread - c.mentions, 0);
      else unread += c.unread;
    }
    return { alerts, unread };
  }, [state?.channels]);

  // Show the count in the browser tab too, like any chat app.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\) /, "");
    document.title = totals.alerts ? `(${totals.alerts > 99 ? "99+" : totals.alerts}) ${base}` : base;
  }, [totals.alerts]);

  const value = useMemo<ChatContextValue>(() => ({
    available, state, people, online, totals, refresh, subscribe, setViewing, markRead,
  }), [available, state, people, online, totals, refresh, subscribe, setViewing, markRead]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
