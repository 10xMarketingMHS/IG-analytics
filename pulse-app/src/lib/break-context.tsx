import { createContext, useContext, type ReactNode } from "react";
import { useBreak } from "@/lib/use-break";

// A single shared break state for the whole shell, so the corner widget and the
// full-screen overlay read/drive the SAME status. Without this each component
// had its own useBreak() instance, and starting a break in the widget only
// reached the overlay on its next 30s poll — the overlay now flips on the
// instant the break actually starts.
type BreakCtx = ReturnType<typeof useBreak>;
const Ctx = createContext<BreakCtx | null>(null);

export function BreakProvider({ children }: { children: ReactNode }) {
  const value = useBreak();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBreakState(): BreakCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBreakState must be used within a BreakProvider");
  return v;
}
