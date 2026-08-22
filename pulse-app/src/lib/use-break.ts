import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { BreakStatus } from "@/lib/types";

// Drives the bottom-right break widget. Polls the server (which is the
// source of truth) periodically, but ticks the displayed remaining time
// locally every second in between so the countdown feels live. If the local
// tick reaches zero while still "on break", it calls end() itself — the
// server would resolve the same auto-expiry on its own next touch, but
// there's no reason to wait for that if this tab is open and watching.
export function useBreak() {
  const [status, setStatus] = useState<BreakStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchedAtRef = useRef(Date.now());
  const endingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api<BreakStatus>("/break/status");
      fetchedAtRef.current = Date.now();
      setStatus(s);
    } catch {
      // Background nicety — leave the last known state on screen.
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Local per-second countdown display, derived from the last server fetch.
  const [displayRemaining, setDisplayRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!status) return;
    if (!status.onBreak) {
      setDisplayRemaining(status.remainingSeconds);
      return;
    }
    const tick = () => {
      const elapsedSinceFetch = (Date.now() - fetchedAtRef.current) / 1000;
      const remaining = Math.max(0, status.remainingSeconds - elapsedSinceFetch);
      setDisplayRemaining(remaining);
      if (remaining <= 0 && !endingRef.current) {
        endingRef.current = true;
        end().finally(() => { endingRef.current = false; });
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function start() {
    setBusy(true);
    try {
      const s = await api<BreakStatus>("/break/start", { method: "POST" });
      fetchedAtRef.current = Date.now();
      setStatus(s);
      return s;
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    setBusy(true);
    try {
      const s = await api<BreakStatus>("/break/end", { method: "POST" });
      fetchedAtRef.current = Date.now();
      setStatus(s);
      return s;
    } finally {
      setBusy(false);
    }
  }

  return { status, displayRemaining, busy, start, end };
}
