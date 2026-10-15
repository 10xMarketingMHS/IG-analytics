import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Loader } from "@/components/loader";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TeamPanel } from "@/pages/team-panel";
import { TaskPanel } from "@/pages/tasks";

// My Team — the admin's view of everyone on the roster: ranked by Task Points
// for a chosen date range, with each person's tasks and how far each has got.
// Admin-only (the sidebar hides it and this page turns anyone else away).
export function MyTeamPage() {
  const { isAdmin, loading, active, workspaces } = useWorkspaces();
  const { tasks, refetch } = useTasks();
  const { editors } = useEditors();
  // Held by id so the open panel always shows the freshest copy after a refetch.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = (tasks ?? []).find((t) => t.id === openTaskId) ?? null;

  // Wait for the role to actually be known: right after sign-in is restored the
  // context briefly reports "not loading" with no workspace yet, and deciding
  // then would bounce an admin away on a direct visit or refresh.
  if (loading || !active) return <section className="screen"><Loader label="Loading…" /></section>;
  if (!isAdmin) return <Navigate to="/home" replace />;

  return (
    <section className="screen">
      <TeamPanel tasks={tasks} editors={editors} onOpenTask={(t) => setOpenTaskId(t.id)} />
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
