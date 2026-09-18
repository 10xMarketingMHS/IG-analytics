// Client side of auto-polling sync. The server owns the real safety (per-
// connection in-flight lock, backoff, failure classification); this just decides
// WHEN to fire the existing per-connection sync endpoints, and only for the
// connections actually represented among the posts in view. Deliberately mounted
// in the Posts view only — not every page that shows post-derived data — to keep
// the concurrent-trigger surface small during rollout. Gated by the org's
// DB-backed kill switch + interval so both flip without a deploy.
import { useEffect, useMemo, useRef } from "react";
import { api } from "./api";
import { useResource } from "./use-resource";
import type { Platform } from "./types";

export type AutoSyncSettings = { enabled: boolean; intervalMinutes: number };

export type Connection = {
  id: string;
  provider: "instagram" | "facebook" | "youtube";
  account_id: string;
  channel_id: string;
  platform_key: string;
  last_synced_at?: string | null;
  sync_in_progress?: boolean;
  consecutive_failures?: number;
  last_error_type?: "transient" | "permanent" | null;
};

// Fire one connection's sync. `auto:true` marks it an automated poll so the
// server applies backoff / skip-if-locked; the immediate-on-save and manual
// paths pass auto:false to bypass backoff (but the server lock still dedupes).
// Failures surface through connection health, so swallow the error here.
export async function syncConnection(accountId: string, provider: string, opts: { auto?: boolean } = {}) {
  try {
    await api(`/integrations/${provider}/sync`, {
      method: "POST",
      body: JSON.stringify({ accountId, auto: opts.auto ?? false }),
    });
  } catch {
    /* server-side lock/backoff/needs-reconnect is reflected in the status UI */
  }
}

// The connections backing a set of posts (unique), matching each post's channel +
// platform to a connection. Posts carry platform_id; connections carry
// platform_key — bridge them via the platforms list.
export function connectionsForPosts(
  posts: { channel_id?: string | null; platform_id?: string | null }[],
  platforms: Platform[],
  connections: Connection[],
): Connection[] {
  const keyOf = new Map(platforms.map((p) => [p.id, p.key]));
  const wanted = new Set<string>();
  for (const p of posts) {
    if (p.channel_id && p.platform_id) wanted.add(`${p.channel_id}:${keyOf.get(p.platform_id) ?? ""}`);
  }
  return connections.filter((c) => wanted.has(`${c.channel_id}:${c.platform_key}`));
}

// Auto-poll the connections represented among `posts`. Triggers: on mount / when
// the target set first resolves, on a recurring interval (paused while the tab is
// hidden), and immediately on tab refocus (catch up rather than wait a full
// cycle). No-op unless the org's kill switch is on.
export function useAutoSync(
  posts: { channel_id?: string | null; platform_id?: string | null }[] | null,
  platforms: Platform[] | null,
) {
  const { data: settings } = useResource<AutoSyncSettings>("/integrations/auto-sync");
  const { data: connData } = useResource<{ connections: Connection[] }>("/integrations/connections");

  const targets = useMemo(
    () => (posts && platforms && connData ? connectionsForPosts(posts, platforms, connData.connections) : []),
    [posts, platforms, connData],
  );

  // Keep a stable callback that always sees the latest targets, so the effect
  // below doesn't need `targets` in its deps (which would reset the interval on
  // every render).
  const targetsRef = useRef<Connection[]>(targets);
  targetsRef.current = targets;
  const runAll = () => {
    for (const c of targetsRef.current) syncConnection(c.account_id, c.provider, { auto: true });
  };

  const enabled = settings?.enabled ?? false;
  const intervalMs = Math.max(5, settings?.intervalMinutes ?? 30) * 60_000;
  // Re-arm when the actual target set changes (filters), not just its length.
  const targetKey = targets.map((c) => c.id).sort().join(",");

  useEffect(() => {
    if (!enabled || !targetKey) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    const start = () => { stop(); timer = setInterval(() => { if (!document.hidden) runAll(); }, intervalMs); };
    const onVis = () => {
      if (document.hidden) stop();
      else { runAll(); start(); } // refocus: catch up now, then resume ticking
    };
    // Debounce the catch-up fire: rapid filter changes re-run this effect, and
    // clearing the pending timer coalesces them into a single sync burst ~2s
    // after the target set settles (the interval still starts ticking now).
    const settle = document.hidden ? undefined : setTimeout(runAll, 2000);
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { if (settle) clearTimeout(settle); stop(); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, targetKey]);
}

// Returns a function to call right after a post's Link is saved: if auto-sync is
// on, immediately sync that post's channel×platform connection so a brand-new
// post shows data without waiting a full interval. Uses manual semantics
// (bypasses backoff); the server lock still prevents overlap.
export function useSyncOnLinkSave() {
  const { data: settings } = useResource<AutoSyncSettings>("/integrations/auto-sync");
  const { data: connData } = useResource<{ connections: Connection[] }>("/integrations/connections");
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  return (channelId: string, platformId: string) => {
    if (!settings?.enabled || !connData || !platData) return;
    const [target] = connectionsForPosts([{ channel_id: channelId, platform_id: platformId }], platData.platforms, connData.connections);
    if (target) syncConnection(target.account_id, target.provider, { auto: false });
  };
}
