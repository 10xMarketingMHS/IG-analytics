import { useCallback, useEffect, useState } from "react";
import { api, getActiveWorkspaceId } from "@/lib/api";

// In-memory cache keyed by workspace + path. Enables stale-while-revalidate:
// a revisited page renders its last-known data instantly, then refreshes in
// the background. Cleared on logout / workspace switch (the app hard-reloads
// on switch, wiping module state, so scoping the key by workspace is belt-and-
// suspenders).
const cache = new Map<string, unknown>();

export function clearResourceCache() {
  cache.clear();
}

/**
 * Cached fetch of an API resource. Returns cached data immediately (if any)
 * while revalidating; `refetch` forces a network refresh and updates the cache
 * (call it after mutations).
 */
export function useResource<T>(path: string) {
  const key = `${getActiveWorkspaceId() ?? ""}:${path}`;
  const [data, setData] = useState<T | undefined>(cache.get(key) as T | undefined);

  const refetch = useCallback(async () => {
    const fresh = await api<T>(path);
    cache.set(key, fresh);
    setData(fresh);
    return fresh;
  }, [key, path]);

  useEffect(() => {
    // Show cached value instantly on (re)mount, then revalidate.
    setData(cache.get(key) as T | undefined);
    refetch().catch(() => {});
  }, [key, refetch]);

  return { data, loading: data === undefined, refetch };
}
