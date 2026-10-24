import { createContext, useContext, type ReactNode } from "react";
import { useEod } from "@/lib/use-eod";
import { useOrg } from "@/lib/use-org";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useAuth } from "@/lib/auth-context";

// One shared EOD state for the whole authenticated shell — so the root gate, the
// End EOD button on My Day, and the summary card all read/drive the same session.
type EodCtx = ReturnType<typeof useEod>;
const Ctx = createContext<EodCtx | null>(null);

export function EodProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={useEod()}>{children}</Ctx.Provider>;
}

export function useEodState(): EodCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEodState must be used within an EodProvider");
  return v;
}

// Whether this person's work waits for Start day right now: an editor with no
// open work session, while Settings › Attendance requires it. Viewing as
// someone is look-only, so their lock doesn't apply.
export function useDayLocked(): boolean {
  const { session, loading, unlinked } = useEodState();
  const { org } = useOrg();
  const { active } = useWorkspaces();
  const { user } = useAuth();
  const sodRequired = org?.attendance?.requireSod !== false;
  return sodRequired && !user?.viewingAs && active?.role === "editor" && !loading && !unlinked && !session;
}

// Ask for Start day before something that needs it (the shell shows the ask,
// components/app-shell.tsx); `then` runs once the day has started.
export function askStartDay(title: string, then: () => void) {
  window.dispatchEvent(new CustomEvent("pulse:ask-start-day", { detail: { title, then } }));
}
