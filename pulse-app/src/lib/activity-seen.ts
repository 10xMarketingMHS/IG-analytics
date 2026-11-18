// Tracks the newest activity timestamp the user has seen, so the topbar bell can
// show an unread count without a per-user read table on the server. Stored in
// localStorage — each person's own, so on a shared browser the next person's
// bell isn't measured against someone else's — and broadcast via a custom
// event so the bell updates live.
const LEGACY_KEY = "pulse:activitySeen";
const EVENT = "pulse:activitySeen";
let who = "";
const keyOf = () => `${LEGACY_KEY}:${who}`;

// Called by the sign-in state (lib/auth-context.tsx) whenever the person changes.
export function setActivitySeenUser(id: string) {
  if (id === who) return;
  who = id;
  if (!id) return;
  try {
    // the one mark kept before it was per person: carried over once
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(keyOf())) localStorage.setItem(keyOf(), legacy);
    if (legacy) localStorage.removeItem(LEGACY_KEY);
  } catch { /* private window */ }
}

export function getActivitySeen(): string {
  if (!who) return "";
  try { return localStorage.getItem(keyOf()) ?? ""; } catch { return ""; }
}

export function markActivitySeen(iso: string) {
  if (!who) return;
  const prev = getActivitySeen();
  if (!prev || iso > prev) {
    try { localStorage.setItem(keyOf(), iso); } catch { /* private window */ }
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

export function onActivitySeenChange(fn: () => void) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
