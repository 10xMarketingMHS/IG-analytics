import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/use-org";
import { CALENDAR_DEFAULTS, isWorkingNow } from "@/lib/work-calendar";

// Settings › Notifications: which in-app alerts a person gets. Saved on their
// login (notify_prefs); a key that isn't saved counts as on.
export type NotifyKey = "assigned" | "review" | "overdue" | "budget" | "quiet";
export const notifyOn = (prefs: Record<string, boolean> | undefined | null, k: NotifyKey) => prefs?.[k] !== false;

// For the polling alert hooks: should this alert show right now? Off in the
// person's choices → never. "Quiet outside working hours" → only overdue
// alerts (urgent) show outside the work calendar's hours; the rest wait for
// the next poll inside them. Read through a ref, so a poll always sees the
// latest choices without restarting its timer.
export function useAlertGate() {
  const { user } = useAuth();
  const { org } = useOrg();
  const ref = useRef({ prefs: user?.notifyPrefs, cal: org?.calendar ?? CALENDAR_DEFAULTS });
  useEffect(() => { ref.current = { prefs: user?.notifyPrefs, cal: org?.calendar ?? CALENDAR_DEFAULTS }; }, [user?.notifyPrefs, org?.calendar]);
  return {
    // Off entirely: don't look, don't keep track.
    off: (k: NotifyKey) => !notifyOn(ref.current.prefs, k),
    // Held for now by quiet hours: look again on a later poll.
    held: (urgent = false) => !urgent && notifyOn(ref.current.prefs, "quiet") && !isWorkingNow(ref.current.cal),
  };
}
