import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export type EodSession = { id: string; date: string; startedAt: string; endedAt: string | null };
export type EodSummary = {
  date: string;
  status: "not_started" | "active" | "completed";
  startedAt: string | null;
  endedAt: string | null;
  groups: { label: string; n: number }[];
  completedCount: number;
  dueToday: number;
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

  return { session, unlinked, loading, busy, summary, start, end, clearSummary, refresh };
}
