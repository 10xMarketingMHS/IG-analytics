import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onTasksChanged } from "@/lib/task-events";
import { whileVisible } from "@/lib/visible-poll";
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
  | { kind: "reset"; key: string; at: string; userId: string; name: string }
  // approved R&D work (AI Job) to make a Reel, an Ad, both — or not used
  | { kind: "decide"; key: string; at: string; taskId: string; title: string; ref: string | null; typeName: string | null; name: string | null; imageUrl: string | null }
  // approved social work you schedule: set its date · post it today · add its links
  | { kind: "schedule"; key: string; at: string; taskId: string; title: string; ref: string | null; step: "date" | "post" | "links";
      postOn: string | null; postTime: string | null; linksDueOn: string | null; linksDueAt?: string | null; late?: boolean;
      name: string | null; imageUrl: string | null };
export type InboxData = { waiting: InboxItem[]; sent: InboxItem[]; count: number };

let current: { who: string; data: InboxData } | null = null;
let inflight: Promise<void> | null = null;
let inflightWho = "";
let queued: Promise<void> | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

// `fresh`: after you changed something — a look already on its way may have
// left before the change, so another one follows it.
export function refreshInbox(who: string, fresh = false): Promise<void> {
  if (!who) return Promise.resolve();
  // a look still on its way for someone else (before a sign-out): not theirs to share
  if (inflight && inflightWho !== who) inflight = null;
  if (inflight && fresh) {
    queued ??= inflight.then(() => { queued = null; return refreshInbox(who); });
    return queued;
  }
  if (!inflight) {
    inflightWho = who;
    inflight = api<InboxData>("/inbox")
      .then((data) => { current = { who, data }; tell(); })
      .catch(() => { /* kept as it was; the next look tries again */ })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// `who`: the signed-in user's id, so another login never sees this one's Inbox.
// `poll`: re-read every minute while the tab is in view (the app shell does;
// pages just follow along).
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
    const stop = poll ? whileVisible(again, 60_000) : null;
    return () => {
      subs.delete(f);
      window.removeEventListener("pulse:attendance-changed", again);
      offTasks();
      stop?.();
    };
  }, [who, poll]);
  const data = current && current.who === who ? current.data : null;
  return { data, refresh: () => refreshInbox(who, true) };
}
