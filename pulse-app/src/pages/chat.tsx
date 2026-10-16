import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import {
  PersonAvatar, channelTitle, dmVisible, taskLabel, toPlain, useChat,
  type ChatChannel, type ChatMessage, type ChatPerson, type ChatTask,
} from "@/lib/chat";
import { Loader } from "@/components/loader";
import { Modal } from "@/components/modal";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./chat.css";

// Team Chat — Slack-style: conversations on the left, the open one in the
// middle, a thread on the right. The open conversation and thread live in the
// URL (?c=…&t=…), so a notice's "Open" and the browser's Back both work.

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅", "🔥"];
const GROUP_GAP_MS = 5 * 60 * 1000;
const STATUS_LABEL: Record<string, string> = { todo: "To Do", in_progress: "In progress", review: "Review", done: "Done" };

const errText = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong — try again.");

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return dayLabel(iso);
}

// Keep a list sorted oldest → newest with one copy of each message.
function upsert(list: ChatMessage[], m: ChatMessage) {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = m;
    return next;
  }
  const next = [...list, m];
  next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return next;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// What the box shows ("@Priya", "#SID-00012") becomes the stored tokens. Any
// "@Name" that matches someone on the team counts, picked from the list or typed;
// a task only when picked, since a number like SID-00012 repeats across brands.
function encodeBody(text: string, people: ChatPerson[], picked: Map<string, string>) {
  let out = text;
  for (const [label, id] of [...picked].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`#${escapeRe(label)}(?![\\w-])`, "g"), `<task:${id}>`);
  }
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(`@${escapeRe(p.name)}(?![\\w])`, "gi"), `<@${p.id}>`);
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

const TOKEN_RE = /(<@[0-9a-f-]{36}>|<task:[0-9a-f-]{36}>|https?:\/\/[^\s<]+|`[^`\n]+`|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w])_[^_\n]+_(?![\w]))/g;

function MessageText({ body, people, tasks, me, onOpenTask }: {
  body: string; people: Map<string, ChatPerson>; tasks: Record<string, ChatTask>; me: string; onOpenTask: (id: string) => void;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) parts.push(body.slice(last, at));
    last = at + tok.length;
    if (tok.startsWith("<@")) {
      const id = tok.slice(2, -1);
      parts.push(<span key={k++} className={"chat-mention" + (id === me ? " me" : "")}>@{people.get(id)?.name ?? "someone"}</span>);
    } else if (tok.startsWith("<task:")) {
      const id = tok.slice(6, -1);
      const t = tasks[id];
      parts.push(
        <button key={k++} type="button" className="chat-taskchip" onClick={() => t && onOpenTask(id)} disabled={!t}>
          #{t ? taskLabel(t) : "task"}
        </button>,
      );
    } else if (tok.startsWith("http")) {
      parts.push(<a key={k++} href={tok} target="_blank" rel="noopener noreferrer">{tok}</a>);
    } else if (tok.startsWith("`")) {
      parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("*")) {
      parts.push(<b key={k++}>{tok.slice(1, -1)}</b>);
    } else {
      parts.push(<i key={k++}>{tok.slice(1, -1)}</i>);
    }
  }
  if (last < body.length) parts.push(body.slice(last));
  return <>{parts}</>;
}

function TaskCard({ task, onOpen }: { task: ChatTask; onOpen: () => void }) {
  return (
    <button type="button" className="chat-taskcard" onClick={onOpen}>
      <span className="chat-taskcard-top">
        <span className="chat-taskcard-id">{taskLabel(task)}</span>
        <span className={"chat-status st-" + task.status}>{STATUS_LABEL[task.status] ?? task.status}</span>
      </span>
      <span className="chat-taskcard-title">{task.title}</span>
      <span className="chat-taskcard-meta">
        {task.editor_name ? `👤 ${task.editor_name}` : "Unassigned"}
        {task.channel_name && <> · {task.channel_name}</>}
        {task.due_date && <> · Due {task.due_date}</>}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer — @ picks a person, # picks a task
// ---------------------------------------------------------------------------

type Suggest =
  | { kind: "@"; start: number; query: string; items: ChatPerson[]; active: number }
  | { kind: "#"; start: number; query: string; items: ChatTask[]; active: number };

function Composer({ people, me, placeholder, initialText = "", initialPicked, autoFocus, onSubmit, onCancel, submitLabel = "Send" }: {
  people: ChatPerson[];
  me: string;
  placeholder: string;
  initialText?: string;
  initialPicked?: Map<string, string>;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const picked = useRef(new Map(initialPicked ?? []));
  const ref = useRef<HTMLTextAreaElement>(null);
  const taskSearch = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  function lookFor(value: string, caret: number) {
    const before = value.slice(0, caret);
    const at = before.match(/(^|\s)@([^\s@#]{0,30})$/);
    if (at) {
      const query = at[2];
      const q = query.toLowerCase();
      const items = people.filter((p) => p.id !== me && p.name.toLowerCase().includes(q)).slice(0, 7);
      setSuggest(items.length ? { kind: "@", start: caret - query.length - 1, query, items, active: 0 } : null);
      return;
    }
    const hash = before.match(/(^|\s)#([^\s@#]{0,40})$/);
    if (hash) {
      const query = hash[2];
      const start = caret - query.length - 1;
      if (query.length < 2) {
        setSuggest({ kind: "#", start, query, items: [], active: 0 });
        return;
      }
      const ticket = ++taskSearch.current;
      setTimeout(async () => {
        if (ticket !== taskSearch.current) return;
        try {
          const { tasks } = await api<{ tasks: Task[] }>(`/tasks?q=${encodeURIComponent(query)}`);
          if (ticket !== taskSearch.current) return;
          setSuggest({ kind: "#", start, query, items: tasks.slice(0, 7), active: 0 });
        } catch { /* leave the list as it was */ }
      }, 200);
      return;
    }
    taskSearch.current++;
    setSuggest(null);
  }

  function pick(i: number) {
    if (!suggest) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    let insert: string;
    if (suggest.kind === "@") {
      insert = `@${suggest.items[i].name} `;
    } else {
      const t = suggest.items[i];
      const label = taskLabel(t);
      picked.current.set(label, t.id);
      insert = `#${label} `;
    }
    const next = text.slice(0, suggest.start) + insert + text.slice(caret);
    setText(next);
    setSuggest(null);
    const pos = suggest.start + insert.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  }

  async function submit() {
    const body = encodeBody(text, people, picked.current);
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setText("");
      picked.current.clear();
      setSuggest(null);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest && suggest.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggest.items.length;
        const active = (suggest.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        setSuggest({ ...suggest, active } as Suggest);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggest.active);
        return;
      }
    }
    if (e.key === "Escape") {
      if (suggest) { e.preventDefault(); e.stopPropagation(); setSuggest(null); return; }
      if (onCancel) { e.preventDefault(); onCancel(); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="chat-composer">
      {suggest && (
        <div className="chat-suggest">
          {suggest.kind === "@" ? (
            suggest.items.map((p, i) => (
              <button key={p.id} type="button" className={"chat-suggest-row" + (i === suggest.active ? " on" : "")}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                <PersonAvatar person={p} size={22} />
                <b>{p.name}</b>
                {p.designation && <span className="chat-faint">{p.designation}</span>}
              </button>
            ))
          ) : suggest.items.length === 0 ? (
            <div className="chat-suggest-empty">
              {suggest.query.length < 2 ? "Type a task's title or number…" : "No tasks match."}
            </div>
          ) : (
            suggest.items.map((t, i) => (
              <button key={t.id} type="button" className={"chat-suggest-row" + (i === suggest.active ? " on" : "")}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                <span className="chat-taskcard-id">{taskLabel(t)}</span>
                <span className="chat-suggest-title">{t.title}</span>
                <span className={"chat-status st-" + t.status}>{STATUS_LABEL[t.status] ?? t.status}</span>
              </button>
            ))
          )}
        </div>
      )}
      <div className="chat-composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); lookFor(e.target.value, e.target.selectionStart); }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setSuggest(null), 150)}
          maxLength={4000}
        />
        <div className="chat-composer-actions">
          {onCancel && <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? "…" : submitLabel}
          </button>
        </div>
      </div>
      <div className="chat-composer-hint">
        <b>Enter</b> to send · <b>Shift+Enter</b> new line · <b>@</b> mention · <b>#</b> link a task · <b>*bold*</b> <b>_italic_</b>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

function MessageItem({ m, compact, ctx, onReply, inThread }: {
  m: ChatMessage;
  compact: boolean;
  ctx: ConvCtx;
  onReply?: () => void;
  inThread?: boolean;
}) {
  const { me, people, tasks, onOpenTask, canModerate } = ctx;
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const author = people.get(m.authorId ?? "");
  const mine = m.authorId === me;
  const linked = useMemo(
    () => [...new Set([...m.body.matchAll(/<task:([0-9a-f-]{36})>/g)].map((x) => x[1]))].filter((id) => tasks[id]),
    [m.body, tasks],
  );

  async function react(emoji: string) {
    setPicker(false);
    try {
      const out = await api<{ message: ChatMessage }>(`/chat/messages/${m.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
      ctx.onUpdated(out.message);
    } catch (err) {
      toast.error(errText(err));
    }
  }

  async function saveEdit(body: string) {
    const out = await api<{ message: ChatMessage; tasks: Record<string, ChatTask> }>(`/chat/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    ctx.mergeTasks(out.tasks);
    ctx.onUpdated(out.message);
    setEditing(false);
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await api(`/chat/messages/${m.id}`, { method: "DELETE" });
      ctx.onUpdated({ ...m, deleted: true, body: "", reactions: [], mentions: [] });
    } catch (err) {
      toast.error(errText(err));
    }
  }

  const editPicked = useMemo(() => {
    const map = new Map<string, string>();
    for (const id of linked) map.set(taskLabel(tasks[id]), id);
    return map;
  }, [linked, tasks]);

  return (
    <div className={"chat-msg" + (compact ? " compact" : "") + (m.mentions.includes(me) ? " mentions-me" : "")}>
      <div className="chat-msg-gutter">
        {compact ? <span className="chat-msg-time-hover">{timeOf(m.createdAt)}</span> : <PersonAvatar person={author} size={34} />}
      </div>
      <div className="chat-msg-main">
        {!compact && (
          <div className="chat-msg-head">
            <b>{author?.name ?? "Former member"}</b>
            {author?.designation && <span className="chat-faint">{author.designation}</span>}
            <span className="chat-faint" title={new Date(m.createdAt).toLocaleString()}>{timeOf(m.createdAt)}</span>
          </div>
        )}
        {m.deleted ? (
          <div className="chat-msg-body deleted">This message was deleted.</div>
        ) : editing ? (
          <Composer
            people={[...people.values()]}
            me={me}
            placeholder="Edit message"
            initialText={toPlain(m.body, people, tasks)}
            initialPicked={editPicked}
            autoFocus
            submitLabel="Save"
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="chat-msg-body">
            <MessageText body={m.body} people={people} tasks={tasks} me={me} onOpenTask={onOpenTask} />
            {m.editedAt && <span className="chat-faint chat-edited"> (edited)</span>}
          </div>
        )}
        {!m.deleted && !editing && linked.length > 0 && (
          <div className="chat-taskcards">
            {linked.map((id) => <TaskCard key={id} task={tasks[id]} onOpen={() => onOpenTask(id)} />)}
          </div>
        )}
        {m.reactions.length > 0 && (
          <div className="chat-reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} type="button" className={"chat-react" + (r.userIds.includes(me) ? " on" : "")}
                title={r.userIds.map((id) => people.get(id)?.name ?? "Someone").join(", ")}
                onClick={() => react(r.emoji)}>
                {r.emoji} <span>{r.userIds.length}</span>
              </button>
            ))}
          </div>
        )}
        {!inThread && m.replyCount > 0 && onReply && (
          <button type="button" className="chat-threadsum" onClick={onReply}>
            <span className="chat-threadsum-avas">
              {m.replyUserIds.map((id) => <PersonAvatar key={id} person={people.get(id)} size={20} />)}
            </span>
            <b>{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</b>
            {m.lastReplyAt && <span className="chat-faint">Last reply {ago(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {!m.deleted && !editing && (
        <div className={"chat-msg-tools" + (picker ? " open" : "")}>
          {picker ? (
            QUICK_REACTIONS.map((e) => <button key={e} type="button" onClick={() => react(e)}>{e}</button>)
          ) : (
            <>
              <button type="button" title="React" onClick={() => setPicker(true)}>😊</button>
              {onReply && !inThread && <button type="button" title="Reply in thread" onClick={onReply}>💬</button>}
              {mine && <button type="button" title="Edit" onClick={() => setEditing(true)}>✏️</button>}
              {(mine || canModerate) && <button type="button" title="Delete" onClick={() => setConfirmDelete(true)}>🗑️</button>}
            </>
          )}
          {picker && <button type="button" title="Close" onClick={() => setPicker(false)}>✕</button>}
        </div>
      )}
      {confirmDelete && (
        <Modal title="Delete this message?" onClose={() => setConfirmDelete(false)}>
          <p style={{ margin: "0 0 4px", lineHeight: 1.5 }}>
            {mine ? "It'll be replaced with “This message was deleted.” for everyone." : "You're removing someone else's message as an admin. Everyone will see it was deleted."}
          </p>
          <div className="formfoot">
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={remove}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

type ConvCtx = {
  me: string;
  people: Map<string, ChatPerson>;
  tasks: Record<string, ChatTask>;
  mergeTasks: (t: Record<string, ChatTask>) => void;
  onOpenTask: (id: string) => void;
  onUpdated: (m: ChatMessage) => void;
  canModerate: boolean;
};

// Messages with day dividers, an author shown once per run of messages, and a
// "New" line where you'd stopped reading.
function MessageRun({ messages, ctx, newAfter, onReply, inThread }: {
  messages: ChatMessage[];
  ctx: ConvCtx;
  newAfter?: string | null;
  onReply?: (id: string) => void;
  inThread?: boolean;
}) {
  const firstNew = newAfter
    ? messages.find((m) => m.createdAt > newAfter && m.authorId !== ctx.me)?.id
    : undefined;
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        // A thread already opens under its parent and a reply count, so its
        // first reply needs no day line of its own.
        const newDay = prev ? dayLabel(prev.createdAt) !== dayLabel(m.createdAt) : !inThread;
        const compact = !!prev && !newDay && !prev.deleted && prev.authorId === m.authorId && m.id !== firstNew
          && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_GAP_MS;
        return (
          <Fragment key={m.id}>
            {newDay && <div className="chat-day"><span>{dayLabel(m.createdAt)}</span></div>}
            {m.id === firstNew && <div className="chat-newline"><span>New</span></div>}
            <MessageItem m={m} compact={compact} ctx={ctx} inThread={inThread} onReply={onReply ? () => onReply(m.id) : undefined} />
          </Fragment>
        );
      })}
    </>
  );
}

// Stick to the bottom while the reader is there; otherwise leave them be.
function useStickyScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [awayWithNew, setAwayWithNew] = useState(false);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom.current) setAwayWithNew(false);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else setAwayWithNew(true);
  }, deps);
  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setAwayWithNew(false);
  }, []);
  return { ref, atBottom, onScroll, awayWithNew, toBottom };
}

// ---------------------------------------------------------------------------
// The open conversation
// ---------------------------------------------------------------------------

function Conversation({ channel, ctx, threadId, onOpenThread, onInfo, onBack }: {
  channel: ChatChannel;
  ctx: ConvCtx;
  threadId: string | null;
  onOpenThread: (id: string) => void;
  onInfo: () => void;
  onBack: () => void;
}) {
  const chat = useChat();
  const { me, people } = ctx;
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [joining, setJoining] = useState(false);
  // Where you'd read up to when you opened it — the "New" line stays put while
  // you read on.
  const newAfter = useRef(channel.last_read_at);
  const lastMarked = useRef<string | null>(null);
  const keepOffset = useRef<number | null>(null);
  const scroll = useStickyScroll([messages?.length, messages?.[messages.length - 1]?.id]);
  const mergeTasks = ctx.mergeTasks;

  const load = useCallback(async () => {
    const out = await api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask>; hasMore: boolean }>(`/chat/channels/${channel.id}/messages?limit=50`);
    mergeTasks(out.tasks);
    setMessages((prev) => {
      if (!prev) return out.messages;
      let next = prev;
      for (const m of out.messages) next = upsert(next, m);
      return next;
    });
    setHasMore((h) => h || out.hasMore);
  }, [channel.id, mergeTasks]);

  useEffect(() => {
    load().catch((err) => { toast.error(errText(err)); setMessages([]); });
  }, [load]);

  useEffect(() => chat.subscribe((e) => {
    if (e.type === "resync") { load().catch(() => {}); return; }
    if (e.type !== "message" || e.message.channelId !== channel.id || e.message.parentId) return;
    mergeTasks(e.tasks);
    setMessages((prev) => (prev ? upsert(prev, e.message) : prev));
  }), [chat, channel.id, load, mergeTasks]);

  useEffect(() => {
    chat.setViewing({ channelId: channel.id, threadId });
    return () => chat.setViewing({ channelId: null, threadId: null });
  }, [chat, channel.id, threadId]);

  // Read = the newest message has been on screen in a visible tab.
  const newest = messages?.[messages.length - 1];
  const markIfSeen = useCallback(() => {
    if (!newest || !channel.joined || document.hidden || !scroll.atBottom.current) return;
    if (lastMarked.current === newest.id && channel.unread === 0 && channel.mentions === 0) return;
    lastMarked.current = newest.id;
    chat.markRead(channel.id, newest.id);
  }, [newest, channel.joined, channel.id, channel.unread, channel.mentions, chat, scroll.atBottom]);
  useEffect(() => { markIfSeen(); }, [markIfSeen]);
  useEffect(() => {
    const onVis = () => markIfSeen();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [markIfSeen]);

  async function loadOlder() {
    if (!messages?.length || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const out = await api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask>; hasMore: boolean }>(
        `/chat/channels/${channel.id}/messages?limit=50&before=${messages[0].id}`,
      );
      mergeTasks(out.tasks);
      const el = scroll.ref.current;
      keepOffset.current = el ? el.scrollHeight - el.scrollTop : null;
      setMessages((prev) => [...out.messages.filter((m) => !prev?.some((p) => p.id === m.id)), ...(prev ?? [])]);
      setHasMore(out.hasMore);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setLoadingOlder(false);
    }
  }
  // Paging back mustn't jump the view: hold the same message under the eye.
  useLayoutEffect(() => {
    const el = scroll.ref.current;
    if (el && keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    }
  }, [messages, scroll.ref]);

  async function send(body: string) {
    const out = await api<{ message: ChatMessage; tasks: Record<string, ChatTask> }>(`/chat/channels/${channel.id}/messages`, {
      method: "POST", body: JSON.stringify({ body }),
    });
    mergeTasks(out.tasks);
    scroll.atBottom.current = true;
    setMessages((prev) => (prev ? upsert(prev, out.message) : [out.message]));
  }

  async function join() {
    setJoining(true);
    try {
      await api(`/chat/channels/${channel.id}/join`, { method: "POST" });
      await chat.refresh();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setJoining(false);
    }
  }

  const onUpdated = useCallback((m: ChatMessage) => setMessages((prev) => (prev ? upsert(prev, m) : prev)), []);
  const convCtx = useMemo(() => ({ ...ctx, onUpdated }), [ctx, onUpdated]);

  const title = channelTitle(channel, people, me);
  const others = channel.member_ids.filter((id) => id !== me);
  const dmPerson = channel.kind === "dm" && others.length === 1 ? people.get(others[0]) : undefined;

  return (
    <section className="chat-main">
      <header className="chat-head">
        <button type="button" className="btn icon chat-back" onClick={onBack} aria-label="Back to conversations">←</button>
        {channel.kind === "dm" ? (
          <PersonAvatar person={dmPerson ?? people.get(others[0])} size={30} online={dmPerson ? chat.online.has(dmPerson.id) : undefined} />
        ) : (
          <span className="chat-head-hash">{channel.is_private ? "🔒" : "#"}</span>
        )}
        <div className="chat-head-title">
          <b>{channel.kind === "dm" ? title : channel.name}</b>
          <span className="chat-faint">
            {channel.kind === "dm"
              ? dmPerson ? (chat.online.has(dmPerson.id) ? "Online" : dmPerson.designation || "Direct message") : `${channel.member_ids.length} people`
              : channel.topic || `${channel.member_ids.length} member${channel.member_ids.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onInfo}>
          {channel.kind === "dm" ? "Details" : `👥 ${channel.member_ids.length}`}
        </button>
      </header>

      <div className="chat-scroll" ref={scroll.ref} onScroll={(e) => {
        scroll.onScroll();
        if (e.currentTarget.scrollTop < 80) loadOlder();
        if (scroll.atBottom.current) markIfSeen();
      }}>
        {messages === null ? (
          <Loader />
        ) : (
          <>
            {hasMore ? (
              <div className="chat-older">{loadingOlder ? "Loading older messages…" : <button type="button" className="btn btn-sm" onClick={loadOlder}>Load older messages</button>}</div>
            ) : (
              <div className="chat-start">
                <div className="chat-start-ic">{channel.kind === "dm" ? "💬" : channel.is_private ? "🔒" : "#"}</div>
                <b>{channel.kind === "dm" ? `This is the start of your conversation with ${title}.` : `This is the very beginning of #${channel.name}.`}</b>
                {channel.kind === "channel" && channel.topic && <span className="chat-faint">{channel.topic}</span>}
              </div>
            )}
            <MessageRun messages={messages} ctx={convCtx} newAfter={newAfter.current} onReply={onOpenThread} />
          </>
        )}
      </div>
      {scroll.awayWithNew && (
        <button type="button" className="chat-jump" onClick={scroll.toBottom}>↓ New messages</button>
      )}

      {channel.joined ? (
        <Composer
          key={channel.id}
          people={[...people.values()]}
          me={me}
          placeholder={channel.kind === "dm" ? `Message ${title}` : `Message #${channel.name}`}
          autoFocus
          onSubmit={send}
        />
      ) : (
        <div className="chat-joinbar">
          <span>You're looking at <b>#{channel.name}</b>. Join to post and get its notifications.</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={joining} onClick={join}>{joining ? "Joining…" : "Join channel"}</button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Thread panel
// ---------------------------------------------------------------------------

function ThreadPanel({ channel, parentId, ctx, onClose }: {
  channel: ChatChannel;
  parentId: string;
  ctx: ConvCtx;
  onClose: () => void;
}) {
  const chat = useChat();
  const [parent, setParent] = useState<ChatMessage | null>(null);
  const [replies, setReplies] = useState<ChatMessage[] | null>(null);
  const [missing, setMissing] = useState(false);
  const scroll = useStickyScroll([replies?.length]);
  const mergeTasks = ctx.mergeTasks;

  const load = useCallback(async () => {
    try {
      const out = await api<{ parent: ChatMessage; replies: ChatMessage[]; tasks: Record<string, ChatTask> }>(`/chat/messages/${parentId}/thread`);
      mergeTasks(out.tasks);
      setParent(out.parent);
      setReplies(out.replies);
    } catch {
      setMissing(true);
    }
  }, [parentId, mergeTasks]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => chat.subscribe((e) => {
    if (e.type === "resync") { load(); return; }
    if (e.type !== "message") return;
    if (e.message.id === parentId) { mergeTasks(e.tasks); setParent(e.message); }
    if (e.message.parentId === parentId) { mergeTasks(e.tasks); setReplies((prev) => (prev ? upsert(prev, e.message) : prev)); }
  }), [chat, parentId, load, mergeTasks]);

  // A mention waiting in this thread is read once the thread is open.
  const lastReply = replies?.[replies.length - 1];
  useEffect(() => {
    if (lastReply && channel.mentions > 0 && !document.hidden) chat.markRead(channel.id, lastReply.id);
  }, [lastReply, channel.mentions, channel.id, chat]);

  async function send(body: string) {
    const out = await api<{ message: ChatMessage; tasks: Record<string, ChatTask> }>(`/chat/channels/${channel.id}/messages`, {
      method: "POST", body: JSON.stringify({ body, parentId }),
    });
    mergeTasks(out.tasks);
    scroll.atBottom.current = true;
    setReplies((prev) => (prev ? upsert(prev, out.message) : [out.message]));
  }

  const onUpdated = useCallback((m: ChatMessage) => {
    if (m.id === parentId) setParent(m);
    else setReplies((prev) => (prev ? upsert(prev, m) : prev));
  }, [parentId]);
  const threadCtx = useMemo(() => ({ ...ctx, onUpdated }), [ctx, onUpdated]);

  return (
    <aside className="chat-thread">
      <header className="chat-head">
        <div className="chat-head-title">
          <b>Thread</b>
          <span className="chat-faint">{channelTitle(channel, ctx.people, ctx.me)}</span>
        </div>
        <div className="spacer" />
        <button type="button" className="btn icon" onClick={onClose} aria-label="Close thread">✕</button>
      </header>
      <div className="chat-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {missing ? (
          <div className="chat-start"><b>This thread isn't available.</b></div>
        ) : !parent || !replies ? (
          <Loader />
        ) : (
          <>
            <MessageItem m={parent} compact={false} ctx={threadCtx} inThread />
            <div className="chat-day"><span>{replies.length} {replies.length === 1 ? "reply" : "replies"}</span></div>
            <MessageRun messages={replies} ctx={threadCtx} inThread />
          </>
        )}
      </div>
      {channel.joined && parent && !parent.deleted && (
        <Composer key={parentId} people={[...ctx.people.values()]} me={ctx.me} placeholder="Reply…" autoFocus onSubmit={send} />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function ConvList({ activeId, onOpen, onNewChannel, onBrowse, onNewDm }: {
  activeId: string | null;
  onOpen: (id: string) => void;
  onNewChannel: () => void;
  onBrowse: () => void;
  onNewDm: () => void;
}) {
  const { state, people, online } = useChat();
  if (!state) return null;
  const me = state.me;
  const channels = state.channels
    .filter((c) => c.kind === "channel" && c.joined)
    .sort((a, b) => (a.name === "general" ? -1 : b.name === "general" ? 1 : (a.name ?? "").localeCompare(b.name ?? "")));
  const dms = state.channels
    .filter((c) => dmVisible(c, me))
    .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
  const browsable = state.channels.filter((c) => c.kind === "channel" && !c.joined).length;

  return (
    <nav className="chat-list">
      <div className="chat-list-sec">
        <span>Channels</span>
        {state.canCreateChannel && <button type="button" title="New channel" onClick={onNewChannel}>＋</button>}
      </div>
      {channels.map((c) => (
        <button key={c.id} type="button" className={"chat-row" + (c.id === activeId ? " active" : "") + (c.unread ? " unread" : "")} onClick={() => onOpen(c.id)}>
          <span className="chat-row-ic">{c.is_private ? "🔒" : "#"}</span>
          <span className="chat-row-name">{c.name}</span>
          {c.mentions > 0 && <span className="chat-count">{c.mentions}</span>}
        </button>
      ))}
      <button type="button" className="chat-row chat-row-quiet" onClick={onBrowse}>
        <span className="chat-row-ic">🔎</span>
        <span className="chat-row-name">Browse channels{browsable ? ` (${browsable})` : ""}</span>
      </button>

      <div className="chat-list-sec">
        <span>Direct messages</span>
        <button type="button" title="New message" onClick={onNewDm}>＋</button>
      </div>
      {dms.map((c) => {
        const others = c.member_ids.filter((id) => id !== me);
        const solo = others.length === 1 ? people.get(others[0]) : undefined;
        const n = c.unread;
        return (
          <button key={c.id} type="button" className={"chat-row" + (c.id === activeId ? " active" : "") + (n ? " unread" : "")} onClick={() => onOpen(c.id)}>
            {solo ? (
              <PersonAvatar person={solo} size={20} online={online.has(solo.id)} />
            ) : (
              <span className="chat-row-group">{others.length}</span>
            )}
            <span className="chat-row-name">{channelTitle(c, people, me)}</span>
            {n > 0 && <span className="chat-count">{n}</span>}
          </button>
        );
      })}
      {dms.length === 0 && (
        <button type="button" className="chat-row chat-row-quiet" onClick={onNewDm}>
          <span className="chat-row-ic">✉️</span>
          <span className="chat-row-name">Message someone</span>
        </button>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Pickers and dialogs
// ---------------------------------------------------------------------------

function PeoplePicker({ people, selected, onToggle, exclude, max }: {
  people: ChatPerson[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  exclude?: Set<string>;
  max?: number;
}) {
  const { online } = useChat();
  const [q, setQ] = useState("");
  const list = people.filter((p) => !exclude?.has(p.id) && (p.name + " " + p.designation).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="chat-picker">
      <input className="t" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="chat-picker-list">
        {list.length === 0 && <div className="chat-suggest-empty">Nobody matches.</div>}
        {list.map((p) => {
          const on = selected.has(p.id);
          const full = !on && max !== undefined && selected.size >= max;
          return (
            <label key={p.id} className={"chat-picker-row" + (on ? " on" : "") + (full ? " full" : "")}>
              <input type="checkbox" checked={on} disabled={full} onChange={() => onToggle(p.id)} />
              <PersonAvatar person={p} size={26} online={online.has(p.id)} />
              <span><b>{p.name}</b>{p.designation && <span className="chat-faint"> · {p.designation}</span>}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

const toggleIn = (set: Set<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
};

function NewChannelModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { state, refresh } = useChat();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [everyone, setEveryone] = useState(true);
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const me = state?.me ?? "";
  const tidy = name.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");

  async function create() {
    setBusy(true);
    try {
      const out = await api<{ channelId: string }>("/chat/channels", {
        method: "POST",
        body: JSON.stringify({ name: tidy, topic, isPrivate, everyone: !isPrivate && everyone, memberIds: [...members] }),
      });
      await refresh();
      onCreated(out.channelId);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New channel" onClose={onClose}>
      <div className="field">
        <label className="f">Name</label>
        <div className="chat-hashinput"><span>#</span><input className="t" placeholder="e.g. design-team" value={name} maxLength={41} onChange={(e) => setName(e.target.value)} autoFocus /></div>
        <div className="hint">Lowercase letters, numbers and dashes — spaces become dashes.</div>
      </div>
      <div className="field">
        <label className="f">What's it for? <span className="chat-faint">(optional)</span></label>
        <input className="t" placeholder="e.g. Thumbnails, edits and feedback" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} />
      </div>
      <div className="field">
        <label className="chat-check"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private — only people you add can see it</label>
        {!isPrivate && (
          <label className="chat-check"><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Add everyone on the team</label>
        )}
      </div>
      {(isPrivate || !everyone) && state && (
        <div className="field">
          <label className="f">Add people {members.size > 0 && <span className="chat-faint">({members.size})</span>}</label>
          <PeoplePicker people={state.people} selected={members} exclude={new Set([me])} onToggle={(id) => setMembers((s) => toggleIn(s, id))} />
        </div>
      )}
      <div className="formfoot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !tidy} onClick={create}>{busy ? "Creating…" : "Create channel"}</button>
      </div>
    </Modal>
  );
}

function NewDmModal({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const { state, refresh } = useChat();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const out = await api<{ channelId: string }>("/chat/dm", { method: "POST", body: JSON.stringify({ userIds: [...picked] }) });
      await refresh();
      onOpened(out.channelId);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }
  if (!state) return null;
  return (
    <Modal title="New message" onClose={onClose}>
      <p className="chat-faint" style={{ margin: "0 0 12px" }}>Pick one person, or up to seven for a group chat. Only the people in it can read it.</p>
      <PeoplePicker people={state.people} selected={picked} exclude={new Set([state.me])} max={7} onToggle={(id) => setPicked((s) => toggleIn(s, id))} />
      <div className="formfoot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || picked.size === 0} onClick={open}>{busy ? "Opening…" : picked.size > 1 ? "Start group chat" : "Open chat"}</button>
      </div>
    </Modal>
  );
}

function BrowseModal({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const { state, refresh } = useChat();
  const [busy, setBusy] = useState<string | null>(null);
  if (!state) return null;
  const all = state.channels.filter((c) => c.kind === "channel").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  async function join(id: string) {
    setBusy(id);
    try {
      await api(`/chat/channels/${id}/join`, { method: "POST" });
      await refresh();
      onOpen(id);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal title="Browse channels" onClose={onClose}>
      <div className="chat-browse">
        {all.map((c) => (
          <div key={c.id} className="chat-browse-row">
            <div>
              <b>{c.is_private ? "🔒 " : "# "}{c.name}</b>
              <div className="chat-faint">{c.topic || "No description"} · {c.member_ids.length} member{c.member_ids.length === 1 ? "" : "s"}</div>
            </div>
            {c.joined ? (
              <button className="btn btn-sm" onClick={() => onOpen(c.id)}>Open</button>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-sm" onClick={() => onOpen(c.id)}>View</button>
                <button className="btn btn-primary btn-sm" disabled={busy === c.id} onClick={() => join(c.id)}>Join</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function InfoModal({ channel, onClose, onLeft }: { channel: ChatChannel; onClose: () => void; onLeft: () => void }) {
  const { state, people, online, refresh } = useChat();
  const me = state?.me ?? "";
  const canManage = channel.kind === "channel" && (channel.created_by === me || !!state?.isAdmin);
  const isGeneral = channel.kind === "channel" && channel.name === "general";
  const [name, setName] = useState(channel.name ?? "");
  const [topic, setTopic] = useState(channel.topic);
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const members = channel.member_ids.map((id) => people.get(id)).filter((p): p is ChatPerson => !!p).sort((a, b) => a.name.localeCompare(b.name));

  async function run(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      done?.();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }
  const save = () => run(() => api(`/chat/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ name: isGeneral ? undefined : name, topic }) }), () => toast.success("Saved"));
  const add = () => run(() => api(`/chat/channels/${channel.id}/members`, { method: "POST", body: JSON.stringify({ userIds: [...toAdd] }) }), () => { setAdding(false); setToAdd(new Set()); });
  const leave = () => run(() => api(`/chat/channels/${channel.id}/leave`, { method: "POST" }), onLeft);
  const archive = () => run(() => api(`/chat/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }), onLeft);

  return (
    <Modal title={channel.kind === "dm" ? "Conversation details" : `#${channel.name}`} onClose={onClose}>
      {canManage && (
        <>
          {!isGeneral && (
            <div className="field">
              <label className="f">Name</label>
              <div className="chat-hashinput"><span>#</span><input className="t" value={name} maxLength={41} onChange={(e) => setName(e.target.value)} /></div>
            </div>
          )}
          <div className="field">
            <label className="f">Description</label>
            <input className="t" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -6, marginBottom: 14 }}>
            <button className="btn btn-sm" disabled={busy} onClick={save}>Save changes</button>
          </div>
        </>
      )}
      {!canManage && channel.kind === "channel" && channel.topic && <p style={{ marginTop: 0 }}>{channel.topic}</p>}

      <div className="chat-info-sec">
        <b>{members.length} {members.length === 1 ? "member" : "members"}</b>
        {channel.kind === "channel" && channel.joined && !adding && <button className="btn btn-sm" onClick={() => setAdding(true)}>＋ Add people</button>}
      </div>
      {adding && state ? (
        <>
          <PeoplePicker people={state.people} selected={toAdd} exclude={new Set(channel.member_ids)} onToggle={(id) => setToAdd((s) => toggleIn(s, id))} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button className="btn btn-sm" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={busy || toAdd.size === 0} onClick={add}>Add {toAdd.size || ""}</button>
          </div>
        </>
      ) : (
        <div className="chat-members">
          {members.map((p) => (
            <div key={p.id} className="chat-member">
              <PersonAvatar person={p} size={28} online={online.has(p.id)} />
              <span><b>{p.name}</b>{p.id === me && <span className="chat-faint"> (you)</span>}{p.designation && <span className="chat-faint"> · {p.designation}</span>}</span>
            </div>
          ))}
        </div>
      )}

      {channel.kind === "channel" && !isGeneral && (
        <div className="formfoot">
          {canManage && <button className="btn" disabled={busy} onClick={archive}>Archive channel</button>}
          {channel.joined && <button className="btn" disabled={busy} onClick={leave}>Leave channel</button>}
        </div>
      )}
    </Modal>
  );
}

// Open a linked task in the Task Board's own panel, right here.
function TaskOpener({ taskId, summary, onClose }: { taskId: string; summary: ChatTask | undefined; onClose: () => void }) {
  const { editors } = useEditors();
  const { workspaces, active } = useWorkspaces();
  const [task, setTask] = useState<Task | null>(null);
  // Looked up by its TID (unique across the org); the title is a fallback.
  const q = summary?.tid || summary?.title || "";
  const load = useCallback(async () => {
    const { tasks } = await api<{ tasks: Task[] }>(`/tasks?q=${encodeURIComponent(q)}`);
    const found = tasks.find((t) => t.id === taskId) ?? null;
    if (!found) { toast.error("That task isn't there any more."); onClose(); return; }
    setTask(found);
  }, [q, taskId, onClose]);
  useEffect(() => { load().catch((err) => { toast.error(errText(err)); onClose(); }); }, [load, onClose]);
  if (!task) return null;
  return (
    <TaskPanel
      mode="edit" task={task} canWrite={active?.role !== "viewer"} editors={editors ?? []} channels={workspaces ?? []}
      onClose={onClose}
      onChanged={() => { load().catch(() => {}); }}
      onCreated={() => {}}
    />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// The chat fills the window below the top bar; the page itself doesn't scroll.
// Measured once the chat is on screen (`ready`), not while it's still loading.
function useFitHeight(ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      el.style.height = `${Math.max(window.innerHeight - el.getBoundingClientRect().top - 14, 360)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ready]);
  return ref;
}

export function ChatPage() {
  const chat = useChat();
  const { state, people, available } = chat;
  const [params, setParams] = useSearchParams();
  const channelId = params.get("c");
  const threadId = params.get("t");
  const [tasks, setTasks] = useState<Record<string, ChatTask>>({});
  const [dialog, setDialog] = useState<null | "channel" | "dm" | "browse" | "info">(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const fitRef = useFitHeight(!!state && available);

  const me = state?.me ?? "";
  const channel = state?.channels.find((c) => c.id === channelId) ?? null;
  const general = state?.channels.find((c) => c.kind === "channel" && c.name === "general");

  // Land on #general (desktop) when nothing is picked.
  useEffect(() => {
    if (!channelId && general && window.innerWidth > 860) setParams({ c: general.id }, { replace: true });
  }, [channelId, general, setParams]);

  // A link to a conversation the list doesn't have yet (just made, just
  // invited): fetch the list once more.
  const { refresh } = chat;
  const hasState = !!state;
  const known = !!channel;
  useEffect(() => {
    if (hasState && channelId && !known) refresh();
  }, [hasState, channelId, known, refresh]);

  const mergeTasks = useCallback((t: Record<string, ChatTask>) => {
    if (Object.keys(t).length) setTasks((prev) => ({ ...prev, ...t }));
  }, []);

  const open = useCallback((id: string) => { setDialog(null); setParams({ c: id }); }, [setParams]);
  const openThread = useCallback((id: string) => { if (channelId) setParams({ c: channelId, t: id }); }, [channelId, setParams]);
  const closeThread = useCallback(() => { if (channelId) setParams({ c: channelId }); }, [channelId, setParams]);
  const closeTask = useCallback(() => setOpenTaskId(null), []);

  const ctx = useMemo<ConvCtx>(() => ({
    me,
    people,
    tasks,
    mergeTasks,
    onOpenTask: setOpenTaskId,
    onUpdated: () => {},
    canModerate: channel?.kind === "channel" && !!state?.isAdmin,
  }), [me, people, tasks, mergeTasks, channel?.kind, state?.isAdmin]);

  if (!available) {
    return <div className="card pad" style={{ maxWidth: 520 }}>Team chat is for admins and editors. Ask an admin if you need access.</div>;
  }
  if (!state) return <Loader />;

  return (
    <div className={"chat" + (channelId ? " has-conv" : "") + (threadId ? " has-thread" : "")} ref={fitRef}>
      <ConvList
        activeId={channelId}
        onOpen={open}
        onNewChannel={() => setDialog("channel")}
        onBrowse={() => setDialog("browse")}
        onNewDm={() => setDialog("dm")}
      />
      {channel ? (
        <Conversation
          key={channel.id}
          channel={channel}
          ctx={ctx}
          threadId={threadId}
          onOpenThread={openThread}
          onInfo={() => setDialog("info")}
          onBack={() => setParams({})}
        />
      ) : (
        <section className="chat-main chat-none">
          <div className="chat-start">
            <div className="chat-start-ic">💬</div>
            <b>{channelId ? "This conversation isn't available." : "Pick a conversation"}</b>
            <span className="chat-faint">Channels for the team, direct messages for one-to-one.</span>
          </div>
        </section>
      )}
      {channel && threadId && <ThreadPanel key={threadId} channel={channel} parentId={threadId} ctx={ctx} onClose={closeThread} />}

      {dialog === "channel" && <NewChannelModal onClose={() => setDialog(null)} onCreated={open} />}
      {dialog === "dm" && <NewDmModal onClose={() => setDialog(null)} onOpened={open} />}
      {dialog === "browse" && <BrowseModal onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "info" && channel && (
        <InfoModal channel={channel} onClose={() => setDialog(null)} onLeft={() => { setDialog(null); if (general) open(general.id); }} />
      )}
      {/* Outside the chat card: its glass blur would otherwise pin the task
          drawer inside the card instead of the window's right edge. */}
      {openTaskId && createPortal(<TaskOpener taskId={openTaskId} summary={tasks[openTaskId]} onClose={closeTask} />, document.body)}
    </div>
  );
}
