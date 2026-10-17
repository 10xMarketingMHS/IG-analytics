import { useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/loader";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TeamPanel } from "@/pages/team-panel";
import { TeamToday } from "@/pages/team-today";
import { TeamRoster } from "@/pages/team-roster";
import { TaskPanel } from "@/pages/tasks";

// My Team — the admin's view of everyone on the roster (Pulse Redesign v5):
// Today, live — who is working, on a break, not started or wrapped up, and on
// what; and Ranking — everyone ranked by Task Points for the dates you pick,
// with each person's tasks and the Excel report; and Roster — everyone's
// position, login and role, changed on the row. Admin-only (the sidebar hides
// it and this page turns anyone else away).
export function MyTeamPage() {
  const { isAdmin, loading, active, workspaces } = useWorkspaces();
  const { tasks, refetch } = useTasks();
  const { editors } = useEditors();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab = raw === "ranking" || raw === "roster" ? raw : "today";
  // Goals' "View in Team" hands over the person to show.
  const focusId = (location.state as { editorId?: string } | null)?.editorId ?? null;
  // Held by id so the open panel always shows the freshest copy after a refetch.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = (tasks ?? []).find((t) => t.id === openTaskId) ?? null;

  // Wait for the role to actually be known: right after sign-in is restored the
  // context briefly reports "not loading" with no workspace yet, and deciding
  // then would bounce an admin away on a direct visit or refresh.
  if (loading || !active) return <section className="screen"><Loader label="Loading…" /></section>;
  if (!isAdmin) return <Navigate to="/home" replace />;

  return (
    <section className="screen mt-page">
      <div className="mt mt-tabs">
        <button type="button" className={tab === "today" ? "on" : ""} onClick={() => setParams({}, { replace: true })} aria-pressed={tab === "today"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" /></svg>
          Today
        </button>
        <button type="button" className={tab === "ranking" ? "on" : ""} onClick={() => setParams({ tab: "ranking" }, { replace: true })} aria-pressed={tab === "ranking"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4" /></svg>
          Ranking
        </button>
        <button type="button" className={tab === "roster" ? "on" : ""} onClick={() => setParams({ tab: "roster" }, { replace: true })} aria-pressed={tab === "roster"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2" /><circle cx="9" cy="11.5" r="2.5" /><path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 10h3M15 14h3M9 5V3h6v2" /></svg>
          Roster
        </button>
      </div>
      {tab === "today"
        ? <TeamToday tasks={tasks} editors={editors} onOpenTask={(t) => setOpenTaskId(t.id)} focusId={focusId} />
        : tab === "ranking"
          ? <TeamPanel tasks={tasks} editors={editors} onOpenTask={(t) => setOpenTaskId(t.id)} focusId={focusId} />
          : <TeamRoster />}
      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => { setOpenTaskId(null); refetch().catch(() => {}); }}
          onChanged={() => { refetch().catch(() => {}); }}
          onCreated={() => {}}
        />
      )}
    </section>
  );
}
