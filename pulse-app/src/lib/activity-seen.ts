// Tracks the newest activity timestamp the user has seen, so the topbar bell can
// show an unread count without a per-user read table on the server. Stored in
// localStorage and broadcast via a custom event so the bell updates live.
const KEY = "pulse:activitySeen";
const EVENT = "pulse:activitySeen";

export function getActivitySeen(): string {
  return localStorage.getItem(KEY) ?? "";
}

export function markActivitySeen(iso: string) {
  const prev = getActivitySeen();
  if (!prev || iso > prev) {
    localStorage.setItem(KEY, iso);
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

export function onActivitySeenChange(fn: () => void) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
