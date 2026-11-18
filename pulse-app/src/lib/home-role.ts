// Home role from the position (Team › Roster): Manager and Asst. Manager get
// the Manager Home, Team Lead the Team lead Home, everyone else the Editor
// Home; an admin whose position isn't an Editor's or Viewer (none, or an older
// title) counts as a Manager. Mirrors homeRoleOf() in server/src/attendance.js.
export type HomeRole = "manager" | "lead" | "editor";

// Senior Editor, Editor and Junior Editor: one level; only the title differs.
const EDITOR_TITLES = ["senior editor", "editor", "junior editor"];

export function homeRoleOf(designation: string | null | undefined, isAdmin: boolean): HomeRole {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "manager" || p === "asst. manager" || p === "assistant manager") return "manager";
  if (p === "team lead") return "lead";
  if (isAdmin && !EDITOR_TITLES.includes(p) && p !== "viewer") return "manager";
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
// The team's hierarchy (Team › Roster positions): Manager › Asst. Manager ›
// Team Lead › Editor (Senior, Junior: the same level) › Viewer; an admin with no position, or an older title,
// sits at the top. Lower number = more senior. Mirrors rankOf() in
// server/src/hierarchy.js.
export function rankOf(designation: string | null | undefined, isAdmin: boolean): number {
  const k = positionKey(designation);
  if (k === "manager") return 0;
  if (k === "asstManager") return 1;
  if (k === "teamLead") return 2;
  const p = String(designation || "").trim().toLowerCase();
  if (p === "viewer") return 4;
  if (isAdmin && !EDITOR_TITLES.includes(p)) return 0;
  return 3;
}
// The order people are listed in (Goals › Set goals, Discipline): by position —
// Manager, Asst. Manager, Team Lead, Senior Editor, Editor, Junior Editor, then
// any other title, Viewer last — and by name within a position.
const LIST_ORDER = ["manager", "asst. manager", "team lead", "senior editor", "editor", "junior editor"];
export function listOrderOf(designation: string | null | undefined): number {
  const p = String(designation || "").trim().toLowerCase();
  if (p === "assistant manager") return 1;
  if (p === "viewer") return LIST_ORDER.length + 1;
  const i = LIST_ORDER.indexOf(p);
  return i < 0 ? LIST_ORDER.length : i;
}
export const byPosition = <T extends { name: string; designation?: string | null }>(a: T, b: T) =>
  listOrderOf(a.designation) - listOrderOf(b.designation) || a.name.localeCompare(b.name);
// Who someone sees in lists of people: the Super Admin sees everyone; anyone
// else, admins included, sees people at their own level or below (and
// themselves), never above them, as with tasks. `keep` stays listed
// regardless (say, a task's current assignee).
export function peopleVisibleTo<T extends { id: string; designation?: string | null; is_admin?: boolean }>(
  people: T[], me: { id: string; designation?: string | null } | null, viewer: { seesAll: boolean; isAdmin: boolean }, keep?: string | null,
): T[] {
  if (viewer.seesAll || !me) return people;
  const mine = rankOf(me.designation, viewer.isAdmin);
  return people.filter((p) => p.id === me.id || p.id === keep || rankOf(p.designation, !!p.is_admin) >= mine);
}

export function seesTeamAttendance(designation: string | null | undefined, isAdmin: boolean, teamView?: Partial<Record<TeamViewKey, boolean>>) {
  if (isAdmin) return true;
  const k = positionKey(designation);
  return !!k && teamView?.[k] !== false;
}
