import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// 7h 40m / 45m — a length of time, not a clock time.
export function fmtDuration(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export type EodSession = { id: string; date: string; startedAt: string; endedAt: string | null };
export type EodSummary = {
  date: string;
  status: "not_started" | "active" | "completed";
  startedAt: string | null;
  endedAt: string | null;
  groups: { label: string; n: number }[];
  completedCount: number;
  // Tasks due on this day, and how many of those are done — a separate figure
  // from completedCount (work finished today is often due another day).
  dueToday: number;
  dueTodayDone?: number;
  // Time actually clocked in across the day's sessions (gaps between them
  // excluded), the day's break total when known, and whether End Work was never
  // pressed so the day was closed automatically.
  workedSeconds?: number;
  sessionCount?: number;
  breakSeconds?: number | null;
  autoClosed?: boolean;
  // The morning plan compared with the day: planned vs done, what from the plan
  // wasn't done, and what was worked on outside it. null when no plan was sent.
  plan?: SodComparison | null;
};

// Start of Day (SOD) — the plan an employee sends once each morning.
export type SodTask = {
  id: string;
  title: string;
  format: string | null;
  dueDate: string | null;
  status: string;
  // added = created by them this morning; today = already on their plate (due
  // today or late, in progress, sent back, waiting for Accept); later = open
  // but due later, in the plan only if they ticked it.
  // skipped = on their plate but left out of today's plan (shown, not counted).
  group: "added" | "today" | "later" | "skipped";
  reason: string;
};
export type SodPlan = {
  id: string;
  date: string;
  submittedAt: string;
  note: string | null;
  tasks: SodTask[];
  editorName: string | null;
  startedAt: string | null;
};
export type SodToday = { required: boolean; plan: SodPlan | null; startedAt: string | null; candidates: SodTask[] };
export type SodComparison = {
  submittedAt: string;
  note: string | null;
  plannedCount: number;
  doneCount: number;
  notDone: string[];
  // Planned tasks an admin deleted during the day — not counted either way.
  removed?: string[];
  unplanned: string[];
};

// The caller's own EOD state — their currently-open session (or none), plus
// start()/end(). Shared for the whole shell via EodProvider so the gate, the End
// button on My Day, and the summary all read/drive one source.
export function useEod() {
  const [session, setSession] = useState<EodSession | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // The just-ended day's summary. Held here (not inside a page) so it can render
  // ABOVE the gate — ending re-locks the app, so a page-level card would unmount
  // before it's seen.
  const [summary, setSummary] = useState<EodSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ session: EodSession | null; unlinked?: boolean }>("/eod/status");
      setSession(d.session);
      setUnlinked(!!d.unlinked);
    } catch {
      /* keep last-known state on a transient error */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Keep it current when it changes somewhere else — another device, an
  // automatic close, the server refusing work: re-check every minute, when the
  // tab comes back into view, and right after such a refusal.
  useEffect(() => {
    const id = setInterval(refresh, 60_000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pulse:workday-changed", refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pulse:workday-changed", refresh);
    };
  }, [refresh]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api<{ session: EodSession }>("/eod/start", { method: "POST" });
      setSession(d.session);
    } finally {
      setBusy(false);
    }
  }, []);

  const end = useCallback(async (): Promise<EodSummary | null> => {
    setBusy(true);
    try {
      const d = await api<{ session: EodSession; summary: EodSummary }>("/eod/end", { method: "PATCH" });
      setSession(null); // ended → the gate re-locks until the next Start EOD
      setSummary(d.summary); // surfaced above the gate
      return d.summary;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearSummary = useCallback(() => setSummary(null), []);

  // Start of Day: fetched whenever a work session opens. While a plan is due the
  // Plan your day window opens by itself; once sent it can be reopened to view it.
  const [sod, setSod] = useState<SodToday | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const refreshSod = useCallback(async () => {
    try {
      const d = await api<SodToday>("/sod/today");
      setSod(d);
      if (d.required) setPlanOpen(true);
    } catch {
      /* keep last-known state on a transient error */
    }
  }, []);
  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (sessionId) refreshSod();
    else { setSod(null); setPlanOpen(false); }
  }, [sessionId, refreshSod]);
  const sendPlan = useCallback(async (note: string, extraTaskIds: string[], skipTaskIds: string[] = []) => {
    const d = await api<{ plan: SodPlan }>("/sod", {
      method: "POST",
      body: JSON.stringify({ note: note.trim() || undefined, extraTaskIds, skipTaskIds }),
    });
    setSod((s) => ({ required: false, plan: d.plan, startedAt: s?.startedAt ?? null, candidates: [] }));
    return d.plan;
  }, []);

  return {
    session, unlinked, loading, busy, summary, start, end, clearSummary, refresh,
    sod, planOpen, setPlanOpen, refreshSod, sendPlan,
  };
}
