import { useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/loader";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TeamPanel } from "@/pages/team-panel";
import { TeamToday } from "@/pages/team-today";
import { TaskPanel } from "@/pages/tasks";

// My Team — the admin's view of everyone on the roster (Pulse Redesign v5):
// Today, live — who is working, on a break, not started or wrapped up, and on
// what; and Ranking — everyone ranked by Task Points for the dates you pick,
// with each person's tasks and the Excel report. Admin-only (the sidebar hides
// it and this page turns anyone else away). The roster itself — logins and
// roles — is in Settings › Team.
export function MyTeamPage() {
  const { isAdmin, loading, active, workspaces } = useWorkspaces();
  const { tasks, refetch } = useTasks();
  const { editors } = useEditors();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "ranking" ? "ranking" : "today";
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
        <span className="mt-grow" />
        <Link to="/teams" className="mt-rosterlink">Roster and logins in Settings</Link>
      </div>
      {tab === "today"
        ? <TeamToday tasks={tasks} editors={editors} onOpenTask={(t) => setOpenTaskId(t.id)} focusId={focusId} />
        : <TeamPanel tasks={tasks} editors={editors} onOpenTask={(t) => setOpenTaskId(t.id)} focusId={focusId} />}
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
