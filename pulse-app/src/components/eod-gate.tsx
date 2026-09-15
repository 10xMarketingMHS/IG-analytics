import { type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { useEodState } from "@/lib/eod-context";
import { EodSummaryCard } from "@/components/eod-summary-card";

// Root-level host for the EOD summary card. It renders ABOVE the app (a sibling
// of the shell, outside the grayscale lock), so it stays visible after End EOD
// re-locks the app. The lockout itself — grayscale + disabling of everything
// except a few live controls — is applied in-place by AppShell; there is no
// full-screen blocking splash.
export function EodGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { summary, clearSummary } = useEodState();
  return (
    <>
      {children}
      {summary && (
        <EodSummaryCard
          name={(user?.name || user?.email || "You").split(" ")[0].split("@")[0]}
          summary={summary}
          onClose={clearSummary}
        />
      )}
    </>
  );
}
