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
  // The Start of Day compared with the day: planned vs done, what from it
  // wasn't done, and what was worked on outside it. null when no SOD was copied.
  plan?: SodComparison | null;
  // The day's tasks with their status, channel and the note written for each.
  tasks?: EodDayTask[];
};

// One of the day's tasks in the End of Day window and report.
export type EodDayTask = {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "review" | "done";
  onHold: boolean;
  completedAt: string | null;
  format: string | null;
  channel: string | null;
  note: string | null;
};

// Start of Day (SOD) — the list an employee copies for WhatsApp each morning
// (saved on every copy; the latest copy is today's SOD).
export type SodTask = {
  id: string;
  title: string;
  format: string | null;
  dueDate: string | null;
  status: string;
  // added = created by them today; today = already on their plate (due today or
  // late, in progress, sent back, waiting for Accept); later = open but due later.
  // skipped = added or on their plate but unticked (shown, not counted).
  group: "added" | "today" | "later" | "skipped";
  reason: string;
  // The task's channel (brand); missing on SODs saved before it was recorded.
  channel?: string | null;
  // The window's starting tick (only on /sod/today's candidates).
  suggested?: boolean;
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
export type SodToday = { plan: SodPlan | null; startedAt: string | null; candidates: SodTask[] };
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

  // End of Day: End Work opens this window first — the day's tasks with a note
  // box each. Notes can be saved along the way; ending saves them, ends the
  // day and shows the summary. `signOutAfter` is set when it was opened from
  // "End Work and sign out", so the shell signs out once the summary closes.
  const [eodOpen, setEodOpen] = useState(false);
  const [signOutAfter, setSignOutAfter] = useState(false);
  const openEod = useCallback((thenSignOut = false) => {
    setSignOutAfter(thenSignOut);
    setEodOpen(true);
  }, []);
  const closeEod = useCallback((ended: boolean) => {
    setEodOpen(false);
    if (!ended) setSignOutAfter(false);
  }, []);
  const clearSignOutAfter = useCallback(() => setSignOutAfter(false), []);
  const saveNotes = useCallback(async (notes: { taskId: string; note: string }[]) => {
    const d = await api<{ summary: EodSummary }>("/eod/notes", { method: "PUT", body: JSON.stringify({ notes }) });
    return d.summary;
  }, []);

  // Start of Day: the window opened from My Day (openSod) — fetched fresh each
  // time it opens, so tasks just added on the board are there. Copy SOD saves
  // the ticked list (saveSod); nothing waits on it.
  const [sod, setSod] = useState<SodToday | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const refreshSod = useCallback(async () => {
    try {
      setSod(await api<SodToday>("/sod/today"));
    } catch {
      /* keep last-known state on a transient error */
    }
  }, []);
  const openSod = useCallback(() => {
    setPlanOpen(true);
    refreshSod();
  }, [refreshSod]);
  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (sessionId) refreshSod();
    else { setSod(null); setPlanOpen(false); }
  }, [sessionId, refreshSod]);
  const saveSod = useCallback(async (taskIds: string[]) => {
    const d = await api<{ plan: SodPlan }>("/sod", { method: "POST", body: JSON.stringify({ taskIds }) });
    setSod((s) => (s ? { ...s, plan: d.plan } : s));
    return d.plan;
  }, []);

  return {
    session, unlinked, loading, busy, summary, start, end, clearSummary, refresh,
    eodOpen, openEod, closeEod, signOutAfter, clearSignOutAfter, saveNotes,
    sod, planOpen, setPlanOpen, openSod, refreshSod, saveSod,
  };
}
