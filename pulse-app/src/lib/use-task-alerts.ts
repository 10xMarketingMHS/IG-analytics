import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { whileVisible } from "@/lib/visible-poll";
import { onTasksChanged } from "@/lib/task-events";
import type { Task } from "@/lib/types";

// The open tasks the background alerts look at — a new task for you, one over
// its time budget, one past its due date, work waiting for your review — in
// one slim request a minute for all of them, only while the tab is in view
// (and whenever tasks change). "team": the open tasks you can see (admins and
// reviewers); "mine": only your own. One copy for the app.
export type AlertScope = "team" | "mine" | null;
let current: { key: string; tasks: Task[] } | null = null;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();

function load(key: string) {
  if (!inflight) {
    inflight = api<{ tasks: Task[] }>(key)
      .then((d) => { current = { key, tasks: d.tasks }; subs.forEach((f) => f()); })
      .catch(() => { /* kept as it was; the next look tries again */ })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useTaskAlertList(scope: AlertScope): Task[] | null {
  const key = scope === "team" ? "/tasks?open=1&lite=1" : scope === "mine" ? "/tasks?assignee=me&open=1&lite=1" : "";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!key) return;
    const f = () => setTick((n) => n + 1);
    subs.add(f);
    load(key);
    const stop = whileVisible(() => { load(key); }, 60_000);
    const offTasks = onTasksChanged(() => { load(key); });
    return () => { subs.delete(f); stop(); offTasks(); };
  }, [key]);
  return current && current.key === key ? current.tasks : null;
}
