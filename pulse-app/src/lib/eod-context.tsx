import { createContext, useContext, type ReactNode } from "react";
import { useEod } from "@/lib/use-eod";

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
