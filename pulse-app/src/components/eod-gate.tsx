import { type ReactNode } from "react";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useAuth } from "@/lib/auth-context";
import { useEodState } from "@/lib/eod-context";
import { Loader } from "@/components/loader";
import { EodSummaryCard } from "@/components/eod-summary-card";

// The whole-app lockout. Editors with no currently-open EOD session see ONLY a
// Start EOD screen — no sidebar, no routes. Admins and viewers bypass entirely.
// Placed inside ProtectedRoute so it wraps every authenticated route (URL access
// included). Server-side task routes enforce the same rule independently.
export function EodGate({ children }: { children: ReactNode }) {
  const { active, loading: wsLoading } = useWorkspaces();
  const { user } = useAuth();
  const { session, loading, unlinked, busy, start, summary, clearSummary } = useEodState();
  const role = active?.role;

  const gated = role === "editor" && !unlinked;

  let content: ReactNode;
  if (wsLoading || (gated && loading)) {
    content = <Loader fullscreen size={160} />;
  } else if (!gated || session) {
    // Admin/viewer/unlinked, or an editor who's clocked in → the real app.
    content = <>{children}</>;
  } else {
    // Gated editor with no open session → block everything.
    content = (
      <div className="eod-gate">
        <div className="eod-gate-card">
          <div className="eod-gate-ic">🌅</div>
          <h1 className="eod-gate-h">Start your day</h1>
          <p className="eod-gate-p">
            Clock in to Pulse to open your tasks and the rest of the app. When you're
            finished, end your day from <b>My Day</b> to get your work summary.
          </p>
          <button className="btn btn-primary eod-gate-btn" onClick={() => start()} disabled={busy}>
            {busy ? "Starting…" : "▶ Start EOD"}
          </button>
        </div>
      </div>
    );
  }

  // The just-ended summary renders ABOVE whatever's showing — because ending
  // re-locks the app, so it appears over the (re-shown) Start EOD screen.
  return (
    <>
      {content}
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
