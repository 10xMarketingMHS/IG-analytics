// Home role from the position (Team › Roster): Manager and Asst. Manager get
// the Manager Home, Team Lead the Team lead Home, everyone else the Editor
// Home; an admin whose position isn't Editor or Viewer (none, or an older
// title) counts as a Manager. Mirrors homeRoleOf() in server/src/attendance.js.
export type HomeRole = "manager" | "lead" | "editor";

export function homeRoleOf(designation: string | null | undefined, isAdmin: boolean): HomeRole {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "manager" || p === "asst. manager" || p === "assistant manager") return "manager";
  if (p === "team lead") return "lead";
  if (isAdmin && p !== "editor" && p !== "viewer") return "manager";
  return "editor";
}

export const HOME_ROLE_LABEL: Record<HomeRole, string> = { manager: "Manager", lead: "Team lead", editor: "Editor" };

// Team attendance access (Settings › Attendance, set by a Super Admin): which
// positions besides admins see the whole team's attendance. Mirrors
// positionKey() / callerScope() in server/src/attendance.js.
export type TeamViewKey = "manager" | "asstManager" | "teamLead";
export function positionKey(designation: string | null | undefined): TeamViewKey | null {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "manager") return "manager";
  if (p === "asst. manager" || p === "assistant manager") return "asstManager";
  if (p === "team lead") return "teamLead";
  return null;
}
export function seesTeamAttendance(designation: string | null | undefined, isAdmin: boolean, teamView?: Partial<Record<TeamViewKey, boolean>>) {
  if (isAdmin) return true;
  const k = positionKey(designation);
  return !!k && teamView?.[k] !== false;
}
