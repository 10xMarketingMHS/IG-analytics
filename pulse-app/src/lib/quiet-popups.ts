import { useSyncExternalStore } from "react";

// Focus Mode (lib/widgets.tsx): pop-ups about something new (a chat message, a new
// or overdue task) wait while it's on. What they say is still in the bell and the
// Inbox; when it ends, one line says how many waited. Confirmations of what you
// just did ("Saved") aren't sent through here, so they still show.
let quiet = false;
let held = 0;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

// Returns how many waited, when turning it off.
export function setQuiet(on: boolean): number {
  if (on === quiet) return 0;
  quiet = on;
  const waited = on ? 0 : held;
  held = 0;
  changed();
  return waited;
}

export function popup(show: () => void) {
  if (!quiet) { show(); return; }
  held += 1;
  changed();
}

export const useQuiet = () => useSyncExternalStore(subscribe, () => quiet);
export const useHeld = () => useSyncExternalStore(subscribe, () => held);
