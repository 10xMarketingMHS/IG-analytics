import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import {
  PersonAvatar, channelTitle, dmVisible, taskLabel, toPlain, useChat,
  type ChatChannel, type ChatMessage, type ChatPerson, type ChatTask,
} from "@/lib/chat";
import { useAuth } from "@/lib/auth-context";
import { Loader } from "@/components/loader";
import { Modal } from "@/components/modal";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { fmtWait } from "@/lib/task-timing";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./chat.css";
import { clockTime, dateTime } from "@/lib/time-format";

// Team Chat — Slack-style: conversations on the left, the open one in the
// middle, a thread on the right. The open conversation and thread live in the
// URL (?c=…&t=…, and &m=… to jump to one message), so a notice's "Open" and the
// browser's Back both work. Starred and Saved head the list; each conversation
// can be muted, has its pins, and keeps your unsent draft.

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅", "🔥"];
// One click from the hover bar, as in the redesign.
const HOVER_REACTIONS = ["✅", "👀", "🔥"];
const COMPOSER_EMOJI = ["😀", "😂", "😊", "😍", "🤔", "😅", "😮", "😢", "🙏", "👍", "👏", "🙌", "💪", "🔥", "🎉", "✅", "👀", "💯", "❤️", "🚀"];
const GROUP_GAP_MS = 5 * 60 * 1000;
const STATUS_LABEL: Record<string, string> = { todo: "To Do", in_progress: "In progress", review: "In review", done: "Done" };
const SECTIONS_KEY = "pulse-chat-closed-sections";
// Unsent text, per person and conversation (and thread), in this browser.
const DRAFT_PREFIX = "pulse-chat-draft:";
const draftKeyFor = (me: string, channelId: string, parentId?: string | null) => `${DRAFT_PREFIX}${me}:${channelId}${parentId ? ":" + parentId : ""}`;
type Draft = { t: string; p: [string, string][] };
function readDraft(key: string): Draft | null {
  try { const d = JSON.parse(window.localStorage.getItem(key) ?? "null"); return d && typeof d.t === "string" ? d : null; } catch { return null; }
}
function writeDraft(key: string, text: string, picked: Map<string, string>) {
  try {
    if (text.trim()) window.localStorage.setItem(key, JSON.stringify({ t: text, p: [...picked] }));
    else window.localStorage.removeItem(key);
  } catch { /* fine, just not kept */ }
  window.dispatchEvent(new Event("pulse:chat-drafts"));
}
// "Priya is typing…", "Priya and Arun are typing…", "Several people are typing…"
function typingLine(ids: string[], people: Map<string, ChatPerson>) {
  const names = ids.map((id) => people.get(id)?.name?.split(" ")[0] ?? "Someone");
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

const errText = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong — try again.");

function timeOf(iso: string) {
  return clockTime(iso);
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

// "Today", "Tomorrow", "2 days late", "Thu 22 Oct" — for a task's due date.
function dueLabel(due: string | null) {
  if (!due) return "No due date";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + "T00:00:00");
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} late`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
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
  // @channel: everyone in the conversation; @here: everyone in it who's online
  out = out.replace(/(^|[^\w<])@(channel|here)(?![\w-])/gi, (_m, pre, w) => `${pre}<!${w.toLowerCase()}>`);
  return out.trim();
}

// Line icons, drawn by stroke so they take the text colour.
const svg = (children: ReactNode, size = 18) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
);
const I = {
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, 16),
  compose: svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  chevron: svg(<path d="m6 9 6 6 6-6" />, 14),
  plus: svg(<path d="M12 5v14M5 12h14" />, 15),
  info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>),
  smile: svg(<><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></>),
  reply: svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />),
  edit: svg(<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />),
  trash: svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2M19 6l-1 14H6L5 6" /></>),
  link: svg(<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>, 16),
  list: svg(<><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>, 16),
  code: svg(<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />, 16),
  at: svg(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>),
  hash: svg(<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />),
  send: svg(<path d="m22 2-7 20-4-9-9-4Z" />),
  check: svg(<path d="M20 6 9 17l-5-5" />, 15),
  undo: svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>, 15),
  open: svg(<><path d="M15 3h6v6M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>, 15),
  task: svg(<><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>, 16),
  lock: svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 15),
  back: svg(<path d="M15 18 9 12l6-6" />),
  close: svg(<path d="M18 6 6 18M6 6l12 12" />),
  star: svg(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" />, 17),
  bell: svg(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>, 17),
  bellOff: svg(<><path d="M8.7 3A6 6 0 0 1 18 8c0 2.7.4 4.6 1 6M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M3 3l18 18" /></>, 17),
  pin: svg(<><path d="M12 17v5" /><path d="M9 3h6l-1 6 3 4H7l3-4Z" /></>, 16),
  bookmark: svg(<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />, 16),
  pencil: svg(<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />, 13),
};

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

const TOKEN_RE = /(<@[0-9a-f-]{36}>|<!(?:channel|here)>|<task:[0-9a-f-]{36}>|https?:\/\/[^\s<]+|`[^`\n]+`|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w])_[^_\n]+_(?![\w])|(?<![\w~])~[^~\n]+~(?![\w~]))/g;

function MessageText({ body, people, tasks, me, onOpenTask }: {
  body: string; people: Map<string, ChatPerson>; tasks: Record<string, ChatTask>; me: string; onOpenTask: (id: string) => void;
}) {
  // A line starting "- " reads as a bullet.
  const text = body.replace(/^(\s*)- /gm, "$1• ");
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    last = at + tok.length;
    if (tok.startsWith("<@")) {
      const id = tok.slice(2, -1);
      parts.push(<span key={k++} className={"chat-mention" + (id === me ? " me" : "")}>@{people.get(id)?.name ?? "someone"}</span>);
    } else if (tok.startsWith("<!")) {
      parts.push(<span key={k++} className="chat-mention all">@{tok.slice(2, -1)}</span>);
    } else if (tok.startsWith("<task:")) {
      const id = tok.slice(6, -1);
      const t = tasks[id];
      parts.push(
        <button key={k++} type="button" className="chat-taskchip" onClick={() => t && onOpenTask(id)} disabled={!t}>
          {t ? taskLabel(t) : "task"}
        </button>,
      );
    } else if (tok.startsWith("http")) {
      parts.push(<a key={k++} href={tok} target="_blank" rel="noopener noreferrer">{tok}</a>);
    } else if (tok.startsWith("`")) {
      parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("*")) {
      parts.push(<b key={k++}>{tok.slice(1, -1)}</b>);
    } else if (tok.startsWith("~")) {
      parts.push(<s key={k++}>{tok.slice(1, -1)}</s>);
    } else {
      parts.push(<i key={k++}>{tok.slice(1, -1)}</i>);
    }
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// A linked task: number, status and due date, then who's on it — and, for a
// task waiting in review that this viewer may resolve, Approve / Request
// changes right here (the same rules and calls as the Task Board).
function TaskCard({ task, canResolve, onOpen, onChanged }: {
  task: ChatTask; canResolve: boolean; onOpen: () => void; onChanged: (t: ChatTask) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const inReview = task.status === "review";
  const due = dueLabel(task.due_date);
  const late = task.status !== "done" && /late$/.test(due);

  async function resolve(status: "done" | "in_progress", reviewNote?: string) {
    const noWork = status === "done" && task.link_required && !task.delivery_link;
    if (noWork && !window.confirm(`No work is attached to "${task.title}". Approve it anyway?`)) return;
    setBusy(true);
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({
        status, ...(reviewNote ? { reviewNote } : {}), ...(noWork ? { approveWithoutWork: true } : {}),
      }) });
      toast.success(status === "done" ? `Approved “${task.title}”.` : `Sent “${task.title}” back for changes.`);
      onChanged({ ...task, status, pending_note: reviewNote ?? task.pending_note, review_started_at: null });
      setNoteOpen(false);
      setNote("");
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tc">
      <div className="tc-top">
        <span className="tc-ic">{I.task}</span>
        <span className="tc-id">{taskLabel(task)}</span>
        <span className={"tc-status st-" + task.status}><span className="tc-dot" />{task.pending_note && task.status !== "done" && task.status !== "review" ? "Sent back" : STATUS_LABEL[task.status] ?? task.status}</span>
        <span className={"tc-due" + (late ? " late" : "")}>{task.status === "done" ? "Done" : due}</span>
      </div>
      <button type="button" className="tc-title" onClick={onOpen}>{task.title}</button>
      <div className="tc-meta">
        <PersonAvatar name={task.editor_name ?? "Unassigned"} size={20} />
        <span>{[task.editor_name ?? "Unassigned", task.content_format_name, task.channel_name].filter(Boolean).join(" · ")}</span>
        {inReview && task.review_started_at && (
          <span className="tc-wait" title="How long it has waited for a reviewer">waiting {fmtWait(Date.now() - new Date(task.review_started_at).getTime())}</span>
        )}
      </div>
      {noteOpen ? (
        <form className="tc-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) resolve("in_progress", note.trim()); }}>
          <input className="t" autoFocus value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={`What does ${task.editor_name ?? "the assignee"} need to change?`} aria-label="What needs changing" />
          <button type="submit" className="tc-btn primary" disabled={busy || !note.trim()}>{busy ? "Sending…" : "Send back"}</button>
          <button type="button" className="tc-btn" disabled={busy} onClick={() => { setNoteOpen(false); setNote(""); }}>Cancel</button>
        </form>
      ) : (
        <div className="tc-actions">
          {inReview && canResolve && (
            <>
              <button type="button" className="tc-btn" disabled={busy} onClick={() => setNoteOpen(true)}>{I.undo} Request changes</button>
              <button type="button" className="tc-btn primary" disabled={busy} onClick={() => resolve("done")}>{I.check} {busy ? "Approving…" : "Approve"}</button>
            </>
          )}
          <button type="button" className="tc-btn" onClick={onOpen}>{I.open} Open</button>
          {task.delivery_link && <a className="tc-btn" href={task.delivery_link} target="_blank" rel="noreferrer">See the work</a>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer — formatting bar, @ picks a person, # picks a task
// ---------------------------------------------------------------------------

type Suggest =
  | { kind: "@"; start: number; query: string; items: ChatPerson[]; active: number }
  | { kind: "#"; start: number; query: string; items: ChatTask[]; active: number };

// @channel and @here, offered with people when you type @
const BROADCASTS: ChatPerson[] = [
  { id: "!channel", name: "channel", image_url: null, color: null, designation: "Notify everyone in this conversation" },
  { id: "!here", name: "here", image_url: null, color: null, designation: "Notify everyone here who's online" },
];

function Composer({ people, me, placeholder, initialText = "", initialPicked, autoFocus, onSubmit, onCancel, compact, draftKey, onTyping, broadcast }: {
  people: ChatPerson[];
  me: string;
  placeholder: string;
  initialText?: string;
  initialPicked?: Map<string, string>;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  // The edit box inside a message: no formatting bar or footer extras.
  compact?: boolean;
  // keep unsent text here (this browser) until it's sent
  draftKey?: string;
  // called as you type (the conversation tells the others, a few seconds at a time)
  onTyping?: () => void;
  // offer @channel / @here
  broadcast?: boolean;
}) {
  const draft = useMemo(() => (draftKey ? readDraft(draftKey) : null), [draftKey]);
  const [text, setText] = useState(draft?.t ?? initialText);
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const picked = useRef(new Map(draft?.p ?? initialPicked ?? []));
  // the draft is written a moment after the last keystroke
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!draftKey) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => writeDraft(draftKey, text, picked.current), 300);
    return () => clearTimeout(draftTimer.current);
  }, [draftKey, text]);
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
      const wide = broadcast ? BROADCASTS.filter((b) => b.name.startsWith(q)) : [];
      const items = [...wide, ...people.filter((p) => p.id !== me && p.name.toLowerCase().includes(q))].slice(0, 7);
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
          setSuggest({ kind: "#", start, query, items: tasks.slice(0, 7) as unknown as ChatTask[], active: 0 });
        } catch { /* leave the list as it was */ }
      }, 200);
      return;
    }
    taskSearch.current++;
    setSuggest(null);
  }

  // Replace the selection (or insert at the caret) and put the caret after it.
  function edit(next: string, caret: number) {
    setText(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      lookFor(next, caret);
    });
  }

  function wrap(mark: string) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const sel = text.slice(s, e);
    const next = text.slice(0, s) + mark + sel + mark + text.slice(e);
    edit(next, sel ? e + mark.length * 2 : s + mark.length);
  }

  function insert(str: string) {
    const el = ref.current;
    const s = el?.selectionStart ?? text.length;
    const e = el?.selectionEnd ?? text.length;
    // @ and # only open their pickers after a space or at the start.
    const pad = /^[@#]$/.test(str) && s > 0 && !/\s/.test(text[s - 1]) ? " " : "";
    const next = text.slice(0, s) + pad + str + text.slice(e);
    edit(next, s + pad.length + str.length);
  }

  function bulletLines() {
    const el = ref.current;
    if (!el) return;
    const s = text.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const e = el.selectionEnd;
    const block = text.slice(s, e) || "";
    const lines = (block || "").split("\n").map((l) => (l.startsWith("- ") ? l : "- " + l));
    const out = lines.join("\n");
    edit(text.slice(0, s) + out + text.slice(Math.max(e, s)), s + out.length);
  }

  function pick(i: number) {
    if (!suggest) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    let ins: string;
    if (suggest.kind === "@") {
      ins = `@${suggest.items[i].name} `;
    } else {
      const t = suggest.items[i];
      const label = taskLabel(t);
      picked.current.set(label, t.id);
      ins = `#${label} `;
    }
    const next = text.slice(0, suggest.start) + ins + text.slice(caret);
    setText(next);
    setSuggest(null);
    const pos = suggest.start + ins.length;
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
      if (draftKey) { clearTimeout(draftTimer.current); writeDraft(draftKey, "", picked.current); }
      setSuggest(null);
      setEmojiOpen(false);
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
    if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) {
      e.preventDefault();
      wrap(e.key === "b" ? "*" : "_");
      return;
    }
    if (e.key === "Escape") {
      if (suggest || emojiOpen) { e.preventDefault(); e.stopPropagation(); setSuggest(null); setEmojiOpen(false); return; }
      if (onCancel) { e.preventDefault(); onCancel(); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const keep = (e: React.MouseEvent) => e.preventDefault(); // toolbar clicks keep the caret

  return (
    <div className={"cp" + (compact ? " compact" : "")}>
      {suggest && (
        <div className="cp-suggest">
          {suggest.kind === "@" ? (
            suggest.items.map((p, i) => (
              <button key={p.id} type="button" className={"cp-suggest-row" + (i === suggest.active ? " on" : "")}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                {p.id.startsWith("!") ? <span className="cp-suggest-all">@</span> : <PersonAvatar person={p} size={24} />}
                <b>{p.id.startsWith("!") ? `@${p.name}` : p.name}</b>
                {p.designation && <span className="chat-faint">{p.designation}</span>}
              </button>
            ))
          ) : suggest.items.length === 0 ? (
            <div className="cp-suggest-empty">
              {suggest.query.length < 2 ? "Type a task's title or number…" : "No tasks match."}
            </div>
          ) : (
            suggest.items.map((t, i) => (
              <button key={t.id} type="button" className={"cp-suggest-row" + (i === suggest.active ? " on" : "")}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                <span className="tc-id">{taskLabel(t)}</span>
                <span className="cp-suggest-title">{t.title}</span>
                <span className={"tc-status st-" + t.status}><span className="tc-dot" />{STATUS_LABEL[t.status] ?? t.status}</span>
              </button>
            ))
          )}
        </div>
      )}
      <div className="cp-box">
        {!compact && (
          <div className="cp-tools" role="toolbar" aria-label="Formatting">
            <button type="button" title="Bold (Ctrl+B)" aria-label="Bold" onMouseDown={keep} onClick={() => wrap("*")}><b>B</b></button>
            <button type="button" title="Italic (Ctrl+I)" aria-label="Italic" onMouseDown={keep} onClick={() => wrap("_")}><i>I</i></button>
            <button type="button" title="Strikethrough" aria-label="Strikethrough" onMouseDown={keep} onClick={() => wrap("~")}><s>S</s></button>
            <span className="cp-sep" />
            <button type="button" title="Add a link" aria-label="Add a link" onMouseDown={keep} onClick={() => insert("https://")}>{I.link}</button>
            <button type="button" title="Bulleted list" aria-label="Bulleted list" onMouseDown={keep} onClick={bulletLines}>{I.list}</button>
            <button type="button" title="Code" aria-label="Code" onMouseDown={keep} onClick={() => wrap("`")}>{I.code}</button>
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); lookFor(e.target.value, e.target.selectionStart); if (e.target.value.trim()) onTyping?.(); }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setSuggest(null), 150)}
          maxLength={4000}
          aria-label={placeholder}
        />
        <div className="cp-foot">
          {!compact && (
            <div className="cp-left">
              <button type="button" title="Emoji" aria-label="Emoji" aria-expanded={emojiOpen} onMouseDown={keep} onClick={() => setEmojiOpen((o) => !o)}>{I.smile}</button>
              <button type="button" title="Mention someone" aria-label="Mention someone" onMouseDown={keep} onClick={() => insert("@")}>{I.at}</button>
              <button type="button" title="Link a task" aria-label="Link a task" onMouseDown={keep} onClick={() => insert("#")}>{I.hash}</button>
            </div>
          )}
          <span className="cp-hint">{compact ? "Enter to save · Esc to cancel" : `@ mention${broadcast ? " (@channel, @here)" : ""} · # link a task · Shift+Enter new line`}</span>
          {onCancel && <button type="button" className="tc-btn" onClick={onCancel}>Cancel</button>}
          <button type="button" className={"cp-send" + (text.trim() ? " ready" : "")} disabled={busy || !text.trim()} onClick={submit} aria-label={compact ? "Save" : "Send"} title={compact ? "Save" : "Send"}>
            {compact ? "Save" : I.send}
          </button>
        </div>
        {emojiOpen && (
          <div className="cp-emoji" role="group" aria-label="Pick an emoji">
            {COMPOSER_EMOJI.map((e) => (
              <button key={e} type="button" onMouseDown={keep} onClick={() => insert(e)}>{e}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

type ConvCtx = {
  me: string;
  people: Map<string, ChatPerson>;
  tasks: Record<string, ChatTask>;
  mergeTasks: (t: Record<string, ChatTask>) => void;
  onOpenTask: (id: string) => void;
  onUpdated: (m: ChatMessage) => void;
  canModerate: boolean;
  canResolve: (t: ChatTask) => boolean;
  // stars, mutes, pins and saved messages are in the database
  extras: boolean;
  // you're in this conversation (pin needs it)
  joined: boolean;
  // the message to show (search, pins, saved: Jump)
  focusId?: string | null;
};

function MessageItem({ m, compact, ctx, onReply, inThread }: {
  m: ChatMessage;
  compact: boolean;
  ctx: ConvCtx;
  onReply?: () => void;
  inThread?: boolean;
}) {
  const { me, people, tasks, onOpenTask, canModerate } = ctx;
  const chat = useChat();
  const saved = chat.saved.has(m.id);
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

  async function pin(on: boolean) {
    try {
      const out = await api<{ message: ChatMessage }>(`/chat/messages/${m.id}/pin`, { method: "POST", body: JSON.stringify({ pinned: on }) });
      ctx.onUpdated(out.message);
      toast.success(on ? "Pinned to this conversation." : "Unpinned.");
    } catch (err) {
      toast.error(errText(err));
    }
  }
  async function save(on: boolean) {
    try {
      await chat.toggleSaved(m.id, on);
      toast.success(on ? "Saved for later." : "Removed from Saved.");
    } catch (err) {
      toast.error(errText(err));
    }
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
    <div id={`msg-${m.id}`} className={"msg" + (compact ? " compact" : "") + (m.mentions.includes(me) ? " mentions-me" : "") + (m.pinnedAt ? " pinned" : "") + (ctx.focusId === m.id ? " focus" : "")}>
      <div className="msg-gutter">
        {compact ? <span className="msg-time-hover">{timeOf(m.createdAt).replace(/\s?[AP]M$/i, "")}</span> : <PersonAvatar person={author} name="Former member" size={36} />}
      </div>
      <div className="msg-main">
        {(m.pinnedAt || saved) && !m.deleted && (
          <div className="msg-flags">
            {m.pinnedAt && <span className="msg-flag pin">{I.pin} Pinned{m.pinnedBy ? ` by ${m.pinnedBy === me ? "you" : people.get(m.pinnedBy)?.name ?? "someone"}` : ""}</span>}
            {saved && <span className="msg-flag saved">{I.bookmark} Saved for later</span>}
          </div>
        )}
        {!compact && (
          <div className="msg-head">
            <b title={author?.designation || undefined}>{author?.name ?? "Former member"}</b>
            <span className="msg-time" title={dateTime(m.createdAt)}>{timeOf(m.createdAt)}</span>
          </div>
        )}
        {m.deleted ? (
          <div className="msg-body deleted">This message was deleted.</div>
        ) : editing ? (
          <Composer
            compact
            people={[...people.values()]}
            me={me}
            placeholder="Edit message"
            initialText={toPlain(m.body, people, tasks)}
            initialPicked={editPicked}
            autoFocus
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="msg-body">
            <MessageText body={m.body} people={people} tasks={tasks} me={me} onOpenTask={onOpenTask} />
            {m.editedAt && <span className="msg-edited"> (edited)</span>}
          </div>
        )}
        {!m.deleted && !editing && linked.length > 0 && (
          <div className="msg-cards">
            {linked.map((id) => (
              <TaskCard key={id} task={tasks[id]} canResolve={ctx.canResolve(tasks[id])}
                onOpen={() => onOpenTask(id)} onChanged={(t) => ctx.mergeTasks({ [t.id]: t })} />
            ))}
          </div>
        )}
        {m.reactions.length > 0 && (
          <div className="msg-reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} type="button" className={"msg-react" + (r.userIds.includes(me) ? " on" : "")}
                title={r.userIds.map((id) => people.get(id)?.name ?? "Someone").join(", ")}
                onClick={() => react(r.emoji)}>
                {r.emoji} <span>{r.userIds.length}</span>
              </button>
            ))}
            <button type="button" className="msg-react add" title="Add a reaction" aria-label="Add a reaction" onClick={() => setPicker(true)}>{I.smile}</button>
          </div>
        )}
        {!inThread && m.replyCount > 0 && onReply && (
          <button type="button" className="msg-thread" onClick={onReply}>
            <span className="msg-thread-avas">
              {m.replyUserIds.map((id) => <PersonAvatar key={id} person={people.get(id)} size={20} />)}
            </span>
            <b>{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</b>
            {m.lastReplyAt && <span>Last reply {dayLabel(m.lastReplyAt) === "Today" ? timeOf(m.lastReplyAt) : dayLabel(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {!m.deleted && !editing && (
        <div className={"msg-tools" + (picker ? " open" : "")}>
          {picker ? (
            <>
              {QUICK_REACTIONS.map((e) => <button key={e} type="button" className="emo" onClick={() => react(e)}>{e}</button>)}
              <button type="button" title="Close" aria-label="Close" onClick={() => setPicker(false)}>{I.close}</button>
            </>
          ) : (
            <>
              {HOVER_REACTIONS.map((e) => <button key={e} type="button" className="emo" title={`React ${e}`} aria-label={`React ${e}`} onClick={() => react(e)}>{e}</button>)}
              <span className="msg-tools-sep" aria-hidden="true" />
              <button type="button" title="React" aria-label="React" onClick={() => setPicker(true)}>{I.smile}</button>
              {onReply && !inThread && <button type="button" title="Reply in thread" aria-label="Reply in thread" onClick={onReply}>{I.reply}</button>}
              {ctx.extras && (
                <button type="button" className={saved ? "on" : undefined} title={saved ? "Remove from Saved" : "Save for later"} aria-label={saved ? "Remove from Saved" : "Save for later"} aria-pressed={saved} onClick={() => save(!saved)}>{I.bookmark}</button>
              )}
              {ctx.extras && ctx.joined && (
                <button type="button" className={m.pinnedAt ? "on" : undefined} title={m.pinnedAt ? "Unpin" : "Pin to this conversation"} aria-label={m.pinnedAt ? "Unpin" : "Pin to this conversation"} aria-pressed={!!m.pinnedAt} onClick={() => pin(!m.pinnedAt)}>{I.pin}</button>
              )}
              {mine && <button type="button" title="Edit" aria-label="Edit" onClick={() => setEditing(true)}>{I.edit}</button>}
              {(mine || canModerate) && <button type="button" title="Delete" aria-label="Delete" className="danger" onClick={() => setConfirmDelete(true)}>{I.trash}</button>}
            </>
          )}
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
            {newDay && <div className="day"><span>{dayLabel(m.createdAt)}</span></div>}
            {m.id === firstNew && <div className="newline"><span>New</span></div>}
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

// A few faces and the rest as a number.
function Faces({ ids, people, max = 3, size = 24 }: { ids: string[]; people: Map<string, ChatPerson>; max?: number; size?: number }) {
  return (
    <span className="faces">
      {ids.slice(0, max).map((id) => <PersonAvatar key={id} person={people.get(id)} size={size} />)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The open conversation
// ---------------------------------------------------------------------------

function Conversation({ channel, ctx, threadId, focusId, onOpenThread, onInfo, onPins, onLatest, onBack }: {
  channel: ChatChannel;
  ctx: ConvCtx;
  threadId: string | null;
  // open around this message (search, pins, saved: Jump)
  focusId: string | null;
  onOpenThread: (id: string) => void;
  onInfo: () => void;
  onPins: () => void;
  onLatest: () => void;
  onBack: () => void;
}) {
  const chat = useChat();
  const { me, people } = ctx;
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // opened around an older message: the newest aren't loaded (Jump to latest)
  const [hasNewer, setHasNewer] = useState(false);
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;
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
    if (focusId) {
      const out = await api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask>; hasMore: boolean; hasNewer?: boolean }>(
        `/chat/channels/${channel.id}/messages?limit=50&around=${focusId}`,
      );
      mergeTasks(out.tasks);
      scroll.atBottom.current = false;
      setMessages(out.messages);
      setHasMore(out.hasMore);
      setHasNewer(!!out.hasNewer);
      return;
    }
    const out = await api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask>; hasMore: boolean }>(`/chat/channels/${channel.id}/messages?limit=50`);
    mergeTasks(out.tasks);
    setMessages((prev) => {
      if (!prev) return out.messages;
      let next = prev;
      for (const m of out.messages) next = upsert(next, m);
      return next;
    });
    setHasMore((h) => h || out.hasMore);
  }, [channel.id, mergeTasks, focusId]);

  // Jump: the message in the middle of the screen, lit up for a moment.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!focusId || focused.current || !messages) return;
    const el = document.getElementById(`msg-${focusId}`);
    if (!el) return;
    focused.current = true;
    el.scrollIntoView({ block: "center" });
    scroll.atBottom.current = false;
  }, [focusId, messages, scroll.atBottom]);

  useEffect(() => {
    load().catch((err) => { toast.error(errText(err)); setMessages([]); });
  }, [load]);

  useEffect(() => chat.subscribe((e) => {
    if (e.type === "resync") { load().catch(() => {}); return; }
    if (e.type !== "message" || e.message.channelId !== channel.id || e.message.parentId) return;
    mergeTasks(e.tasks);
    // around an older message, a brand-new one waits for Jump to latest
    setMessages((prev) => (!prev ? prev : hasNewerRef.current && !prev.some((x) => x.id === e.message.id) ? prev : upsert(prev, e.message)));
  }), [chat, channel.id, load, mergeTasks]);

  useEffect(() => {
    chat.setViewing({ channelId: channel.id, threadId });
    return () => chat.setViewing({ channelId: null, threadId: null });
  }, [chat, channel.id, threadId]);

  // Read = the newest message has been on screen in a visible tab.
  const newest = messages?.[messages.length - 1];
  const markIfSeen = useCallback(() => {
    if (!newest || !channel.joined || document.hidden || !scroll.atBottom.current || hasNewerRef.current) return;
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
    // sent from an older stretch: back to the latest, where it is
    if (hasNewerRef.current) { onLatest(); return; }
    scroll.atBottom.current = true;
    setMessages((prev) => (prev ? upsert(prev, out.message) : [out.message]));
  }

  // tell the others you're typing (the server passes it on, every few seconds at most)
  const lastTyping = useRef(0);
  const typingNow = useCallback(() => {
    const now = Date.now();
    if (now - lastTyping.current < 3000) return;
    lastTyping.current = now;
    api(`/chat/channels/${channel.id}/typing`, { method: "POST", body: JSON.stringify({}) }).catch(() => {});
  }, [channel.id]);
  const typers = typingLine(chat.typing[`${channel.id}|`] ?? [], people);

  async function prefs(p: { starred?: boolean; muted?: boolean }) {
    try {
      await chat.setPrefs(channel.id, p);
      if (p.muted !== undefined) toast.success(p.muted ? "Muted: no badge or notices here, except when someone @mentions you by name." : "Unmuted.");
    } catch (err) {
      toast.error(errText(err));
    }
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
  const convCtx = useMemo(() => ({ ...ctx, onUpdated, joined: channel.joined, focusId }), [ctx, onUpdated, channel.joined, focusId]);

  const title = channelTitle(channel, people, me);
  const others = channel.member_ids.filter((id) => id !== me);
  const dmPerson = channel.kind === "dm" && others.length === 1 ? people.get(others[0]) : undefined;
  const sub = channel.kind === "dm"
    ? dmPerson ? (chat.online.has(dmPerson.id) ? "Online" : dmPerson.designation || "Direct message") : `${channel.member_ids.length} people`
    : channel.topic;

  return (
    <section className="cv">
      <header className="cv-head">
        <button type="button" className="iconbtn cv-back" onClick={onBack} aria-label="Back to conversations">{I.back}</button>
        {channel.kind === "dm" ? (
          <PersonAvatar person={dmPerson ?? people.get(others[0])} size={24} online={dmPerson ? chat.online.has(dmPerson.id) : undefined} />
        ) : (
          <span className="cv-hash">{channel.is_private ? I.lock : "#"}</span>
        )}
        <button type="button" className="cv-title" onClick={onInfo} title="Conversation details">
          {channel.kind === "dm" ? title : channel.name}{I.chevron}
        </button>
        {sub && <span className="cv-sub">{sub}</span>}
        <span className="spacer" />
        {channel.kind === "channel" && (
          <button type="button" className="cv-members" onClick={onInfo} title="Members">
            <Faces ids={channel.member_ids} people={people} size={20} />
            <b>{channel.member_ids.length}</b>
          </button>
        )}
        {ctx.extras && channel.joined && (
          <>
            <button type="button" className={"iconbtn" + (channel.starred ? " on star" : "")} onClick={() => prefs({ starred: !channel.starred })}
              title={channel.starred ? "Unstar" : "Star: keep it at the top of your list"} aria-label={channel.starred ? "Unstar" : "Star"} aria-pressed={!!channel.starred}>{I.star}</button>
            <button type="button" className={"iconbtn" + (channel.muted ? " on" : "")} onClick={() => prefs({ muted: !channel.muted })}
              title={channel.muted ? "Unmute" : "Mute: no badge or notices, except @mentions of you"} aria-label={channel.muted ? "Unmute" : "Mute"} aria-pressed={!!channel.muted}>{channel.muted ? I.bellOff : I.bell}</button>
          </>
        )}
        {ctx.extras && (
          <button type="button" className="iconbtn" onClick={onPins} title="Pinned messages" aria-label="Pinned messages">{I.pin}</button>
        )}
        <button type="button" className="iconbtn" onClick={onInfo} title="Details" aria-label="Details">{I.info}</button>
      </header>

      <div className="cv-scroll" ref={scroll.ref} onScroll={(e) => {
        scroll.onScroll();
        if (e.currentTarget.scrollTop < 80) loadOlder();
        if (scroll.atBottom.current) markIfSeen();
      }}>
        {messages === null ? (
          <Loader />
        ) : (
          <>
            {hasMore ? (
              <div className="cv-older">{loadingOlder ? "Loading older messages…" : <button type="button" className="tc-btn" onClick={loadOlder}>Load older messages</button>}</div>
            ) : (
              <div className="cv-start cv-intro">
                {channel.kind === "dm" && dmPerson ? (
                  <PersonAvatar person={dmPerson} size={44} />
                ) : (
                  <div className="cv-start-ic">{channel.kind === "dm" ? I.reply : channel.is_private ? I.lock : "#"}</div>
                )}
                <b>{channel.kind === "dm" ? `This is your conversation with ${title}` : `Welcome to #${channel.name}`}</b>
                <span>
                  {channel.kind === "dm"
                    ? `${dmPerson?.designation ? dmPerson.designation + ". " : ""}Tasks you link here show their live status.`
                    : channel.topic || `This is the very beginning of #${channel.name}.`}
                </span>
              </div>
            )}
            <MessageRun messages={messages} ctx={convCtx} newAfter={newAfter.current} onReply={onOpenThread} />
          </>
        )}
      </div>
      {hasNewer ? (
        <button type="button" className="cv-jump" onClick={onLatest}>Jump to the latest messages</button>
      ) : scroll.awayWithNew && (
        <button type="button" className="cv-jump" onClick={scroll.toBottom}>New messages below</button>
      )}

      <div className="cv-typing" aria-live="polite">{typers}</div>
      {channel.joined ? (
        <Composer
          key={channel.id}
          people={[...people.values()]}
          me={me}
          placeholder={channel.kind === "dm" ? `Message ${title}` : `Message #${channel.name}`}
          autoFocus={!focusId}
          onSubmit={send}
          draftKey={draftKeyFor(me, channel.id)}
          onTyping={typingNow}
          broadcast={channel.kind === "channel" || channel.member_ids.length > 2}
        />
      ) : (
        <div className="cv-joinbar">
          <span>You're looking at <b>#{channel.name}</b>. Join to post and get its notifications.</span>
          <button type="button" className="tc-btn primary" disabled={joining} onClick={join}>{joining ? "Joining…" : "Join channel"}</button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Thread panel
// ---------------------------------------------------------------------------

function ThreadPanel({ channel, parentId, focusId, ctx, onClose }: {
  channel: ChatChannel;
  parentId: string;
  // a reply to show (search, pins, saved: Jump)
  focusId: string | null;
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
  const threadCtx = useMemo(() => ({ ...ctx, onUpdated, joined: channel.joined, focusId }), [ctx, onUpdated, channel.joined, focusId]);

  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!focusId || focused.current || !replies) return;
    const el = document.getElementById(`msg-${focusId}`);
    if (!el) return;
    focused.current = true;
    el.scrollIntoView({ block: "center" });
    scroll.atBottom.current = false;
  }, [focusId, replies, scroll.atBottom]);

  const lastTyping = useRef(0);
  const typingNow = useCallback(() => {
    const now = Date.now();
    if (now - lastTyping.current < 3000) return;
    lastTyping.current = now;
    api(`/chat/channels/${channel.id}/typing`, { method: "POST", body: JSON.stringify({ parentId }) }).catch(() => {});
  }, [channel.id, parentId]);
  const typers = typingLine(chat.typing[`${channel.id}|${parentId}`] ?? [], ctx.people);

  return (
    <aside className="th">
      <header className="cv-head">
        <div className="th-title">
          <b>Thread</b>
          <span className="cv-sub">{channelTitle(channel, ctx.people, ctx.me)}</span>
        </div>
        <span className="spacer" />
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close thread" title="Close thread">{I.close}</button>
      </header>
      <div className="cv-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {missing ? (
          <div className="cv-start"><b>This thread isn't available.</b></div>
        ) : !parent || !replies ? (
          <Loader />
        ) : (
          <>
            <MessageItem m={parent} compact={false} ctx={threadCtx} inThread />
            <div className="th-count"><span>{replies.length} {replies.length === 1 ? "reply" : "replies"}</span></div>
            <MessageRun messages={replies} ctx={threadCtx} inThread />
          </>
        )}
      </div>
      <div className="cv-typing" aria-live="polite">{typers}</div>
      {channel.joined && parent && !parent.deleted && (
        <Composer key={parentId} people={[...ctx.people.values()]} me={ctx.me} placeholder="Reply…" autoFocus={!focusId} onSubmit={send}
          draftKey={draftKeyFor(ctx.me, channel.id, parentId)} onTyping={typingNow}
          broadcast={channel.kind === "channel" || channel.member_ids.length > 2} />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function readClosed(): Record<string, boolean> {
  try { return JSON.parse(window.localStorage.getItem(SECTIONS_KEY) ?? "{}"); } catch { return {}; }
}

// Re-reads which conversations have an unsent draft whenever one changes.
function useDraftIds(me: string) {
  const read = useCallback(() => {
    const ids = new Set<string>();
    try {
      const pre = `${DRAFT_PREFIX}${me}:`;
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k?.startsWith(pre) && !k.slice(pre.length).includes(":")) ids.add(k.slice(pre.length));
      }
    } catch { /* none */ }
    return ids;
  }, [me]);
  const [ids, setIds] = useState<Set<string>>(read);
  useEffect(() => {
    const on = () => setIds(read());
    on();
    window.addEventListener("pulse:chat-drafts", on);
    window.addEventListener("storage", on);
    return () => { window.removeEventListener("pulse:chat-drafts", on); window.removeEventListener("storage", on); };
  }, [read]);
  return ids;
}

function ConvList({ activeId, onOpen, onNewChannel, onBrowse, onNewDm, onDmWith, onSaved, onSearch }: {
  activeId: string | null;
  onOpen: (id: string) => void;
  onNewChannel: () => void;
  onBrowse: () => void;
  onNewDm: () => void;
  onDmWith: (personId: string) => void;
  onSaved: () => void;
  onSearch: (q: string) => void;
}) {
  const { state, people, online, saved } = useChat();
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>(readClosed);
  const drafts = useDraftIds(state?.me ?? "");
  if (!state) return null;
  const me = state.me;
  const query = q.trim().toLowerCase();
  const match = (s: string) => !query || s.toLowerCase().includes(query);

  // Starred conversations sit in their own section at the top.
  const starred = state.channels
    .filter((c) => c.starred && c.joined && (c.kind === "channel" || dmVisible(c, me)) && match(channelTitle(c, people, me)))
    .sort((a, b) => channelTitle(a, people, me).localeCompare(channelTitle(b, people, me)));
  const channels = state.channels
    .filter((c) => c.kind === "channel" && c.joined && !c.starred && match(c.name ?? ""))
    .sort((a, b) => (a.name === "general" ? -1 : b.name === "general" ? 1 : (a.name ?? "").localeCompare(b.name ?? "")));
  const dms = state.channels
    .filter((c) => dmVisible(c, me) && !c.starred && match(channelTitle(c, people, me)))
    .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
  // One row of the list: a channel or a DM, muted ones quiet, with its draft and counts.
  const row = (c: ChatChannel) => {
    const others = c.member_ids.filter((id) => id !== me);
    const solo = c.kind === "dm" && others.length === 1 ? people.get(others[0]) : undefined;
    const count = c.muted ? c.mentions : c.kind === "dm" ? c.unread : c.mentions > 0 ? c.mentions : c.unread;
    const loud = c.mentions > 0 || (c.kind === "dm" && !c.muted);
    const draft = drafts.has(c.id) && c.id !== activeId;
    return (
      <button key={c.id} type="button" className={"cl-row" + (c.id === activeId ? " active" : "") + (c.unread && !c.muted ? " unread" : "") + (c.muted ? " muted" : "")} onClick={() => onOpen(c.id)}>
        {c.kind === "dm"
          ? solo ? <PersonAvatar person={solo} size={20} online={online.has(solo.id)} /> : <span className="cl-group">{others.length}</span>
          : <span className="cl-ic">{c.is_private ? I.lock : "#"}</span>}
        <span className="cl-name">{c.kind === "dm" ? channelTitle(c, people, me) : c.name}</span>
        {draft && <span className="cl-draft" title="Unsent draft">{I.pencil}</span>}
        {c.muted && <span className="cl-muted" title="Muted">{I.bellOff}</span>}
        {count > 0 && <span className={"cl-count" + (loud ? "" : " quiet")}>{count}</span>}
      </button>
    );
  };
  const browsable = state.channels.filter((c) => c.kind === "channel" && !c.joined).length;
  // While searching, people you don't have a one-to-one with yet.
  const withDm = new Set(state.channels.filter((c) => c.kind === "dm" && c.member_ids.length === 2).flatMap((c) => c.member_ids));
  const newPeople = query ? state.people.filter((p) => p.id !== me && !withDm.has(p.id) && match(p.name)) : [];
  const onlineIds = [...online].filter((id) => id !== me && people.has(id));

  function toggle(key: string) {
    setClosed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* fine, just not remembered */ }
      return next;
    });
  }
  const open = (key: string) => !!query || !closed[key];

  const sectionHead = (key: string, label: string, action?: ReactNode) => (
    <div className="cl-sec">
      <button type="button" className={"cl-sec-toggle" + (open(key) ? " open" : "")} onClick={() => toggle(key)} aria-expanded={open(key)}>
        {I.chevron}<span>{label}</span>
      </button>
      {action}
    </div>
  );

  return (
    <nav className="cl" aria-label="Conversations">
      <div className="cl-head">
        <h2>Messages</h2>
        {onlineIds.length > 0 && (
          <span className="cl-online" title={onlineIds.map((id) => people.get(id)?.name).join(", ") + " online"}>
            <Faces ids={onlineIds} people={people} size={18} /> {onlineIds.length} online
          </span>
        )}
        <button type="button" className="iconbtn" title="New message" aria-label="New message" onClick={onNewDm}>{I.compose}</button>
      </div>
      <label className="cl-search">
        {I.search}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a channel, person or message" aria-label="Find a channel, person or message"
          onKeyDown={(e) => { if (e.key === "Enter" && q.trim().length >= 2) onSearch(q.trim()); }} />
      </label>

      <div className="cl-scroll">
        {query.length >= 2 && (
          <button type="button" className="cl-row cl-searchall" onClick={() => onSearch(q.trim())}>
            <span className="cl-ic">{I.search}</span>
            <span className="cl-name">Search messages for “{q.trim()}”</span>
          </button>
        )}
        {state.extras && !query && (
          <button type="button" className="cl-row" onClick={onSaved}>
            <span className="cl-ic">{I.bookmark}</span>
            <span className="cl-name">Saved for later</span>
            {saved.size > 0 && <span className="cl-count quiet">{saved.size}</span>}
          </button>
        )}
        {starred.length > 0 && (
          <>
            {sectionHead("starred", "Starred")}
            {open("starred") && starred.map(row)}
          </>
        )}
        {sectionHead("channels", "Channels", state.canCreateChannel
          ? <button type="button" className="iconbtn sm" title="New channel" aria-label="New channel" onClick={onNewChannel}>{I.plus}</button>
          : undefined)}
        {open("channels") && (
          <>
            {channels.map(row)}
            {!query && (
              <button type="button" className="cl-row quiet" onClick={onBrowse}>
                <span className="cl-ic">{I.plus}</span>
                <span className="cl-name">Browse channels{browsable ? ` (${browsable})` : ""}</span>
              </button>
            )}
          </>
        )}

        {sectionHead("dms", "Direct messages", <button type="button" className="iconbtn sm" title="New message" aria-label="New message" onClick={onNewDm}>{I.plus}</button>)}
        {open("dms") && (
          <>
            {dms.map(row)}
            {!query && dms.length === 0 && (
              <button type="button" className="cl-row quiet" onClick={onNewDm}>
                <span className="cl-ic">{I.compose}</span>
                <span className="cl-name">Message someone</span>
              </button>
            )}
          </>
        )}

        {newPeople.length > 0 && (
          <>
            <div className="cl-sec"><span className="cl-sec-label">People</span></div>
            {newPeople.map((p) => (
              <button key={p.id} type="button" className="cl-row" onClick={() => onDmWith(p.id)}>
                <PersonAvatar person={p} size={20} online={online.has(p.id)} />
                <span className="cl-name">{p.name}</span>
                <span className="cl-hint">Message</span>
              </button>
            ))}
          </>
        )}
        {query && starred.length === 0 && channels.length === 0 && dms.length === 0 && newPeople.length === 0 && query.length < 2 && (
          <div className="cl-empty">Nothing matches “{q.trim()}”.</div>
        )}
      </div>
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
        {list.length === 0 && <div className="cp-suggest-empty">Nobody matches.</div>}
        {list.map((p) => {
          const on = selected.has(p.id);
          const full = !on && max !== undefined && selected.size >= max;
          return (
            <label key={p.id} className={"chat-picker-row" + (on ? " on" : "") + (full ? " full" : "")}>
              <input type="checkbox" checked={on} disabled={full} onChange={() => onToggle(p.id)} />
              <PersonAvatar person={p} size={28} online={online.has(p.id)} />
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

// Matches the server's tidy: "Carousel - DF" → "carousel-df".
const tidyName = (s: string) => s.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "");

function NewChannelModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { state, refresh } = useChat();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [everyone, setEveryone] = useState(true);
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const me = state?.me ?? "";
  const tidy = tidyName(name);

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
        <div className="chat-hashinput"><span>#</span><input className="t" placeholder="e.g. design-team" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus /></div>
        <div className="hint">{tidy && tidy !== name.trim() ? <>It'll be <b>#{tidy}</b></> : "Lowercase letters, numbers and dashes."}</div>
      </div>
      <div className="field">
        <label className="f">What's it for? <span className="chat-faint">(optional)</span></label>
        <input className="t" placeholder="e.g. Thumbnails, edits and feedback" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} />
      </div>
      <div className="field">
        <label className="chat-check"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private: only people you add can see it</label>
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
              <b>{c.is_private ? "Private · " : "# "}{c.name}</b>
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

// Messages listed outside their conversation (pins, saved, search): who, where,
// when, the text, and Jump (plus Unpin / Remove where it applies).
function MessageList({ messages, tasks, empty, action, onJump }: {
  messages: ChatMessage[] | null;
  tasks: Record<string, ChatTask>;
  empty: string;
  action?: (m: ChatMessage) => ReactNode;
  onJump: (m: ChatMessage) => void;
}) {
  const { state, people } = useChat();
  const me = state?.me ?? "";
  if (!messages) return <Loader />;
  if (!messages.length) return <div className="cp-suggest-empty" style={{ padding: "18px 4px" }}>{empty}</div>;
  return (
    <div className="chat-hits">
      {messages.map((m) => {
        const author = people.get(m.authorId ?? "");
        const ch = state?.channels.find((c) => c.id === m.channelId);
        return (
          <div key={m.id} className="chat-hit">
            <PersonAvatar person={author} name="Former member" size={30} />
            <div className="chat-hit-main">
              <div className="chat-hit-head">
                <b>{author?.name ?? "Former member"}</b>
                <span className="chat-faint">{ch ? channelTitle(ch, people, me) : "a conversation"}{m.parentId ? " · in a thread" : ""} · {dayLabel(m.createdAt)} {timeOf(m.createdAt)}</span>
              </div>
              <div className="chat-hit-body"><MessageText body={m.body} people={people} tasks={tasks} me={me} onOpenTask={() => onJump(m)} /></div>
            </div>
            <div className="chat-hit-acts">
              {action?.(m)}
              <button type="button" className="btn btn-sm" onClick={() => onJump(m)}>Jump</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PinsModal({ channel, onClose, onJump }: { channel: ChatChannel; onClose: () => void; onJump: (m: ChatMessage) => void }) {
  const chat = useChat();
  const [list, setList] = useState<{ messages: ChatMessage[]; tasks: Record<string, ChatTask> } | null>(null);
  const load = useCallback(() => {
    api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask> }>(`/chat/channels/${channel.id}/pins`)
      .then(setList).catch((err) => { toast.error(errText(err)); setList({ messages: [], tasks: {} }); });
  }, [channel.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => chat.subscribe((e) => { if ((e.type === "pins" && e.channelId === channel.id) || e.type === "resync") load(); }), [chat, channel.id, load]);
  async function unpin(m: ChatMessage) {
    try {
      await api(`/chat/messages/${m.id}/pin`, { method: "POST", body: JSON.stringify({ pinned: false }) });
      load();
    } catch (err) {
      toast.error(errText(err));
    }
  }
  return (
    <Modal title={`Pinned in ${channelTitle(channel, chat.people, chat.state?.me ?? "")}`} onClose={onClose} wide>
      <MessageList messages={list?.messages ?? null} tasks={list?.tasks ?? {}} empty="Nothing pinned yet. Hover a message and press the pin to keep it here for everyone."
        onJump={onJump} action={channel.joined ? (m) => <button type="button" className="btn btn-sm" onClick={() => unpin(m)}>Unpin</button> : undefined} />
    </Modal>
  );
}

function SavedModal({ onClose, onJump }: { onClose: () => void; onJump: (m: ChatMessage) => void }) {
  const chat = useChat();
  const [list, setList] = useState<{ messages: ChatMessage[]; tasks: Record<string, ChatTask> } | null>(null);
  useEffect(() => {
    api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask> }>("/chat/saved")
      .then(setList).catch((err) => { toast.error(errText(err)); setList({ messages: [], tasks: {} }); });
  }, []);
  async function remove(m: ChatMessage) {
    try {
      await chat.toggleSaved(m.id, false);
      setList((l) => (l ? { ...l, messages: l.messages.filter((x) => x.id !== m.id) } : l));
    } catch (err) {
      toast.error(errText(err));
    }
  }
  return (
    <Modal title="Saved for later" onClose={onClose} wide>
      <p className="chat-faint" style={{ margin: "0 0 10px" }}>Only you see what you save.</p>
      <MessageList messages={list?.messages ?? null} tasks={list?.tasks ?? {}} empty="Nothing saved. Hover a message and press the bookmark to keep it here."
        onJump={onJump} action={(m) => <button type="button" className="btn btn-sm" onClick={() => remove(m)}>Remove</button>} />
    </Modal>
  );
}

function SearchModal({ initial, onClose, onJump }: { initial: string; onClose: () => void; onJump: (m: ChatMessage) => void }) {
  const [q, setQ] = useState(initial);
  const [found, setFound] = useState<{ messages: ChatMessage[]; tasks: Record<string, ChatTask> } | null>(null);
  const ticket = useRef(0);
  useEffect(() => {
    const term = q.trim();
    const mine = ++ticket.current;
    if (term.length < 2) { setFound({ messages: [], tasks: {} }); return; }
    setFound(null);
    const t = setTimeout(() => {
      api<{ messages: ChatMessage[]; tasks: Record<string, ChatTask> }>(`/chat/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (mine === ticket.current) setFound(r); })
        .catch((err) => { if (mine === ticket.current) { toast.error(errText(err)); setFound({ messages: [], tasks: {} }); } });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Modal title="Search messages" onClose={onClose} wide>
      <label className="chat-search-big">
        {I.search}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Words from a message" aria-label="Search messages" autoFocus maxLength={100} />
      </label>
      <p className="chat-faint" style={{ margin: "8px 0 10px" }}>In every conversation you can read: your channels and DMs, and the public channels.</p>
      <MessageList messages={found?.messages ?? null} tasks={found?.tasks ?? {}} empty={q.trim().length < 2 ? "Type at least two letters." : "No messages match."} onJump={onJump} />
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
  // asked once more before someone is taken out
  const [removing, setRemoving] = useState<string | null>(null);
  const members = channel.member_ids.map((id) => people.get(id)).filter((p): p is ChatPerson => !!p).sort((a, b) => a.name.localeCompare(b.name));
  const canRemove = canManage && channel.joined && !isGeneral;

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
  const save = () => run(() => api(`/chat/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ name: isGeneral ? undefined : tidyName(name), topic }) }), () => toast.success("Saved"));
  const add = () => run(() => api(`/chat/channels/${channel.id}/members`, { method: "POST", body: JSON.stringify({ userIds: [...toAdd] }) }), () => { setAdding(false); setToAdd(new Set()); });
  const leave = () => run(() => api(`/chat/channels/${channel.id}/leave`, { method: "POST" }), onLeft);
  const remove = (p: ChatPerson) => run(() => api(`/chat/channels/${channel.id}/members/${p.id}`, { method: "DELETE" }), () => {
    setRemoving(null);
    toast.success(`${p.name} is out of #${channel.name}.${channel.is_private ? " They can't see it any more." : ""}`);
  });
  const archive = () => run(() => api(`/chat/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }), onLeft);

  return (
    <Modal title={channel.kind === "dm" ? "Conversation details" : `#${channel.name}`} onClose={onClose}>
      {canManage && (
        <>
          {!isGeneral && (
            <div className="field">
              <label className="f">Name</label>
              <div className="chat-hashinput"><span>#</span><input className="t" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></div>
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
        {channel.kind === "channel" && channel.joined && !adding && <button className="btn btn-sm" onClick={() => setAdding(true)}>Add people</button>}
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
              <PersonAvatar person={p} size={30} online={online.has(p.id)} />
              <span><b>{p.name}</b>{p.id === me && <span className="chat-faint"> (you)</span>}{p.designation && <span className="chat-faint"> · {p.designation}</span>}</span>
              {canRemove && p.id !== me && (
                removing === p.id ? (
                  <span className="chat-member-acts">
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setRemoving(null)}>Keep</button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => remove(p)}>Remove</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm chat-member-acts" onClick={() => setRemoving(p.id)} title={`Take ${p.name} out of this channel`}>Remove</button>
                )
              )}
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
      el.style.height = `${Math.max(window.innerHeight - el.getBoundingClientRect().top, 360)}px`;
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
  const { user } = useAuth();
  // A failed first load can leave the page with nothing to show; it says why
  // (below) and offers Try again instead of a spinner that never ends.
  const [params, setParams] = useSearchParams();
  const channelId = params.get("c");
  const threadId = params.get("t");
  // a message to show (search, pins, saved: Jump)
  const focusId = params.get("m");
  const [tasks, setTasks] = useState<Record<string, ChatTask>>({});
  const [dialog, setDialog] = useState<null | "channel" | "dm" | "browse" | "info" | "pins" | "saved" | "search">(null);
  const [searchFor, setSearchFor] = useState("");
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
  // Jump to a message: its conversation, around it (a reply: in its thread).
  const jump = useCallback((m: ChatMessage) => {
    setDialog(null);
    setParams(m.parentId ? { c: m.channelId, t: m.parentId, m: m.id } : { c: m.channelId, m: m.id });
  }, [setParams]);
  const latest = useCallback(() => { if (channelId) setParams(threadId ? { c: channelId, t: threadId } : { c: channelId }); }, [channelId, threadId, setParams]);
  const closeTask = useCallback(() => setOpenTaskId(null), []);
  const dmWith = useCallback(async (personId: string) => {
    try {
      const out = await api<{ channelId: string }>("/chat/dm", { method: "POST", body: JSON.stringify({ userIds: [personId] }) });
      await refresh();
      open(out.channelId);
    } catch (err) {
      toast.error(errText(err));
    }
  }, [refresh, open]);

  // The same review rule as My Day and the Task Board: the card names who may
  // review it (server/src/review-route.js). Never your own task. The server
  // checks again either way.
  const canResolve = useCallback((t: ChatTask) => {
    if (t.status !== "review" || !user) return false;
    if (user.editorId && t.editor_id === user.editorId) return false;
    return (t.reviewer_ids ?? []).includes(user.id);
  }, [user]);

  const ctx = useMemo<ConvCtx>(() => ({
    me,
    people,
    tasks,
    mergeTasks,
    onOpenTask: setOpenTaskId,
    onUpdated: () => {},
    canModerate: channel?.kind === "channel" && !!state?.isAdmin,
    canResolve,
    extras: !!state?.extras,
    joined: !!channel?.joined,
  }), [me, people, tasks, mergeTasks, channel?.kind, channel?.joined, state?.isAdmin, state?.extras, canResolve]);

  if (!available) {
    return <div className="card pad" style={{ maxWidth: 520 }}>Team chat is for admins and editors. Ask an admin if you need access.</div>;
  }
  if (!state && chat.loadError) {
    return (
      <div className="card pad" style={{ maxWidth: 560 }}>
        <b>Team Chat couldn't load.</b>
        <p style={{ margin: "6px 0 12px", lineHeight: 1.55, color: "var(--muted)" }}>
          The server answered: “{chat.loadError}”. On a server that's new to Team Chat this usually means
          its chat tables haven't been added to the database yet — the Team Chat database change
          (<code>20261021120000_team_chat.sql</code>) needs to be run once.
        </p>
        <button type="button" className="btn btn-sm" onClick={() => { chat.refresh(); }}>Try again</button>
      </div>
    );
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
        onDmWith={dmWith}
        onSaved={() => setDialog("saved")}
        onSearch={(q) => { setSearchFor(q); setDialog("search"); }}
      />
      {channel ? (
        <Conversation
          // a jump (or back to the latest) starts it afresh around the right messages
          key={`${channel.id}:${threadId ? "" : focusId ?? ""}`}
          channel={channel}
          ctx={ctx}
          threadId={threadId}
          focusId={threadId ? null : focusId}
          onOpenThread={openThread}
          onInfo={() => setDialog("info")}
          onPins={() => setDialog("pins")}
          onLatest={latest}
          onBack={() => setParams({})}
        />
      ) : (
        <section className="cv cv-none">
          <div className="cv-start">
            <div className="cv-start-ic">{I.reply}</div>
            <b>{channelId ? "This conversation isn't available." : "Pick a conversation"}</b>
            <span className="chat-faint">Channels for the team, direct messages for one-to-one.</span>
          </div>
        </section>
      )}
      {channel && threadId && <ThreadPanel key={`${threadId}:${focusId ?? ""}`} channel={channel} parentId={threadId} focusId={focusId} ctx={ctx} onClose={closeThread} />}

      {dialog === "channel" && <NewChannelModal onClose={() => setDialog(null)} onCreated={open} />}
      {dialog === "dm" && <NewDmModal onClose={() => setDialog(null)} onOpened={open} />}
      {dialog === "browse" && <BrowseModal onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "pins" && channel && <PinsModal channel={channel} onClose={() => setDialog(null)} onJump={jump} />}
      {dialog === "saved" && <SavedModal onClose={() => setDialog(null)} onJump={jump} />}
      {dialog === "search" && <SearchModal initial={searchFor} onClose={() => setDialog(null)} onJump={jump} />}
      {dialog === "info" && channel && (
        <InfoModal channel={channel} onClose={() => setDialog(null)} onLeft={() => { setDialog(null); if (general) open(general.id); }} />
      )}
      {/* Outside the chat card, so the task drawer sits at the window's edge. */}
      {openTaskId && createPortal(<TaskOpener taskId={openTaskId} summary={tasks[openTaskId]} onClose={closeTask} />, document.body)}
    </div>
  );
}
