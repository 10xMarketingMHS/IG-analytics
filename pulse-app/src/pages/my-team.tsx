import { Navigate, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/loader";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TeamTracker } from "@/pages/team-tracker";
import { TeamRoster } from "@/pages/team-roster";
import { TeamAttendance } from "@/pages/team-attendance";
import { LeaveScreen } from "@/pages/leave";
import { useAuth } from "@/lib/auth-context";
import { homeRoleOf, seesTeamAttendance } from "@/lib/home-role";
import { useOrg } from "@/lib/use-org";
import "./my-team.css";

// My Team: Tracker — Team tracker (pages/team-tracker.tsx): each person's day
// (working, on a break, done), numbers, profile and task history, for whoever
// leads people (a Manager, Asst. Manager or Team Lead by position, or an
// admin); Attendance — the month's Start of day record; Leave — Approvals and
// Allowances & rules for CL / SL (pages/leave.tsx), for whoever answers leave;
// and Roster — everyone's position, login and role, changed on the row (the
// admins'). The ranking is on the Leaderboard. Anyone with no tab here is
// turned away.
export function MyTeamPage() {
  const { isAdmin, loading, active, pageRule } = useWorkspaces();
  const { user } = useAuth();
  const { editors } = useEditors();
  const me = (editors ?? []).find((e) => e.id === user?.editorId) ?? null;
  const homeRole = homeRoleOf(me?.designation, isAdmin);
  const { org } = useOrg();
  // Team leads and managers who aren't admins: the team's Attendance only when
  // Settings › Attendance lets their position see it.
  const attendanceOnly = !isAdmin && (homeRole === "lead" || homeRole === "manager")
    && seesTeamAttendance(me?.designation, false, org?.attendance?.teamView);
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  // Tracker: a Manager, Asst. Manager or Team Lead by position, or an admin; the server holds the same line
  const canTrack = isAdmin || homeRole !== "editor";
  // Attendance: admins, the leads Settings › Attendance lets see the team, and
  // anyone whose saved Page access row opens My Team
  const showAttendance = isAdmin || attendanceOnly || pageRule("myTeam", "see", false);
  // Leave: whoever answers leave — a Manager or Asst. Manager, or an admin
  const canLeave = isAdmin || homeRole === "manager";
  const showRoster = isAdmin && !attendanceOnly;
  const tabs = ([canTrack && "tracker", showAttendance && "attendance", canLeave && "leave", showRoster && "roster"] as const)
    .filter((x): x is "tracker" | "attendance" | "leave" | "roster" => !!x);
  const tab = tabs.find((x) => x === raw) ?? tabs[0];
  const leaveView = params.get("view") === "settings" ? "settings" : "approve";

  // Wait for the role to actually be known: right after sign-in is restored the
  // context briefly reports "not loading" with no workspace yet, and deciding
  // then would bounce an admin away on a direct visit or refresh.
  if (loading || !active || (!isAdmin && (editors === null || org === null))) return <section className="screen"><Loader label="Loading…" /></section>;
  if (!tab) return <Navigate to="/home" replace />;

  return (
    <section className="screen mt-page">
      <div className="mt mt-tabs">
        {canTrack && (
        <button type="button" className={tab === "tracker" ? "on" : ""} onClick={() => setParams({ tab: "tracker" }, { replace: true })} aria-pressed={tab === "tracker"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8.5 3.5V2.5h7v1" /><circle cx="10" cy="10" r="2" /><path d="M7 16a3 3 0 0 1 6 0M15 9.5h2M15 13h2" /></svg>
          Tracker
        </button>
        )}
        {showAttendance && (
        <button type="button" className={tab === "attendance" ? "on" : ""} onClick={() => setParams({ tab: "attendance" }, { replace: true })} aria-pressed={tab === "attendance"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 11.5-4.2M15.5 18.5l2 2 4-4.5" /></svg>
          Attendance
        </button>
        )}
        {canLeave && (
        <button type="button" className={tab === "leave" ? "on" : ""} onClick={() => setParams({ tab: "leave" }, { replace: true })} aria-pressed={tab === "leave"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /><path d="m9 15 2 2 4-4" /></svg>
          Leave
        </button>
        )}
        {/* the roster (people, logins, positions) stays the admins' */}
        {showRoster && (
        <button type="button" className={tab === "roster" ? "on" : ""} onClick={() => setParams({ tab: "roster" }, { replace: true })} aria-pressed={tab === "roster"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2" /><circle cx="9" cy="11.5" r="2.5" /><path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 10h3M15 14h3M9 5V3h6v2" /></svg>
          Roster
        </button>
        )}
      </div>
      {tab === "tracker"
        ? <TeamTracker embedded />
        : tab === "attendance"
          ? <div className="mt"><TeamAttendance editors={editors} /></div>
          : tab === "leave"
            ? <LeaveScreen mode="team" startTab={leaveView} onTab={(t) => setParams(t === "settings" ? { tab: "leave", view: "settings" } : { tab: "leave" }, { replace: true })} />
            : <TeamRoster />}
    </section>
  );
}
