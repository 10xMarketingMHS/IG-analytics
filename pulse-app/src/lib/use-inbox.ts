import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onTasksChanged } from "@/lib/task-events";
import type { HandoverItem } from "@/components/handover";
import type { LeaveRequest } from "@/lib/use-leave";

// The Inbox (server/src/routes/inbox.js): what's waiting on you — leave,
// permission and start-time correction requests from your people, hand-overs,
// reviews, tasks to accept, password resets (admins) — and what you sent
// that's still waiting. One copy for the app: the sidebar badge and the Inbox
// page read the same answer, re-read every minute and whenever attendance or
// a task changes.

type Who = { editorId: string; name: string; imageUrl: string | null };
export type InboxItem =
  // a manager sees what the asker has left of that type this year
  | ({ kind: "leave"; key: string; at: string; leave: LeaveRequest; balance?: { left: number; total: number } | null } & Partial<Who>)
  | ({ kind: "permission"; key: string; at: string; id: string; date: string; part: "morning" | "evening"; note: string | null } & Partial<Who>)
  | ({ kind: "correction"; key: string; at: string; date: string; correctionAt: string; checkInAt: string | null; note: string | null } & Who)
  | { kind: "handover"; key: string; at: string; handover: HandoverItem }
  | { kind: "review"; key: string; at: string; taskId: string; title: string; ref: string | null; name?: string | null; imageUrl?: string | null; reviewBy?: string | null }
  | { kind: "accept"; key: string; at: string; taskId: string; title: string; ref: string | null; due: string | null; name: string | null }
  | { kind: "reset"; key: string; at: string; userId: string; name: string };
export type InboxData = { waiting: InboxItem[]; sent: InboxItem[]; count: number };

let current: { who: string; data: InboxData } | null = null;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

export function refreshInbox(who: string) {
  if (!who) return Promise.resolve();
  if (!inflight) {
    inflight = api<InboxData>("/inbox")
      .then((data) => { current = { who, data }; tell(); })
      .catch(() => { /* kept as it was; the next look tries again */ })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// `who`: the signed-in user's id, so another login never sees this one's Inbox.
// `poll`: re-read every minute (the app shell does; pages just follow along).
export function useInbox(who: string, poll = false) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!who) return;
    const f = () => setTick((n) => n + 1);
    subs.add(f);
    refreshInbox(who);
    const again = () => { refreshInbox(who); };
    window.addEventListener("pulse:attendance-changed", again);
    const offTasks = onTasksChanged(again);
    const id = poll ? window.setInterval(again, 60_000) : 0;
    return () => {
      subs.delete(f);
      window.removeEventListener("pulse:attendance-changed", again);
      offTasks();
      if (id) window.clearInterval(id);
    };
  }, [who, poll]);
  const data = current && current.who === who ? current.data : null;
  return { data, refresh: () => refreshInbox(who) };
}
