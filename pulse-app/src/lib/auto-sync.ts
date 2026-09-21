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

// Auto-poll connection syncs. Triggers: on mount / when the target set first
// resolves, on a recurring interval (paused while the tab is hidden), and
// immediately on tab refocus (catch up rather than wait a full cycle). No-op
// unless the org's kill switch is on.
//
// Scope: pass `posts` (+ platforms) to poll only the connections behind those
// posts; call with no arguments to poll EVERY connection in the org — used for
// the app-wide poller mounted in the shell, so sync runs on any page while the
// user is logged in and the tab is active, not just on the Posts page.
// `opts.active` gates whether THIS session polls at all — the app-wide poller
// passes `active: isAdmin` so only admin tabs trigger auto-sync (regular users'
// tabs just display data). Defaults true for the scoped form.
export function useAutoSync(
  posts?: { channel_id?: string | null; platform_id?: string | null }[] | null,
  platforms?: Platform[] | null,
  opts?: { active?: boolean },
) {
  const active = opts?.active ?? true;
  const { data: settings } = useResource<AutoSyncSettings>("/integrations/auto-sync");
  const { data: connData } = useResource<{ connections: Connection[] }>("/integrations/connections");

  const targets = useMemo(() => {
    if (!connData) return [];
    if (posts === undefined) return connData.connections; // app-wide: every connection
    if (!posts || !platforms) return [];
    return connectionsForPosts(posts, platforms, connData.connections);
  }, [posts, platforms, connData]);

  // Keep a stable callback that always sees the latest targets, so the effect
  // below doesn't need `targets` in its deps (which would reset the interval on
  // every render).
  const targetsRef = useRef<Connection[]>(targets);
  targetsRef.current = targets;
  const intervalMs = Math.max(5, settings?.intervalMinutes ?? 30) * 60_000;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  // This tab's last-fire time per connection. Don't re-poll a connection this tab
  // already hit within ~80% of the interval, so page navigation / refocus don't
  // spam it. (The server ALSO short-circuits connections synced recently, which
  // is what dedups across the different admins' tabs.)
  const firedRef = useRef<Map<string, number>>(new Map());
  const runAll = () => {
    const now = Date.now();
    const freshMs = intervalRef.current * 0.8;
    for (const c of targetsRef.current) {
      if (now - (firedRef.current.get(c.id) ?? 0) < freshMs) continue;
      firedRef.current.set(c.id, now);
      syncConnection(c.account_id, c.provider, { auto: true });
    }
  };

  const enabled = settings?.enabled ?? false;
  // Re-arm when the actual target set changes (filters), not just its length.
  const targetKey = targets.map((c) => c.id).sort().join(",");

  useEffect(() => {
    if (!enabled || !active || !targetKey) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    // Jitter the interval ±15% so multiple admin tabs don't fire in lockstep.
    const jittered = () => intervalMs * (0.85 + Math.random() * 0.3);
    const start = () => { stop(); timer = setInterval(() => { if (!document.hidden) runAll(); }, jittered()); };
    const onVis = () => {
      if (document.hidden) stop();
      else { runAll(); start(); } // refocus: catch up now, then resume ticking
    };
    // Debounced, jittered catch-up fire so tab-open / rapid re-runs coalesce and
    // several tabs don't all fire at the same instant.
    const settle = document.hidden ? undefined : setTimeout(runAll, 1500 + Math.random() * 3000);
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { if (settle) clearTimeout(settle); stop(); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, intervalMs, targetKey]);
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
