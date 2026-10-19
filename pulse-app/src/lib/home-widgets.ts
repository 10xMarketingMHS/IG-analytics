import type { HomeRole } from "@/lib/home-role";

// The Home widget catalog (Pulse Redesign v7): what each widget is, who may
// use it, and each Home role's default layout. Sizes: 1 = S (one column),
// 2 = M, 3 = L; never more columns than the grid has.

export type WidgetKey =
  | "attend" | "timer" | "upnext" | "mygoals" | "reviews" | "team"
  | "goalpace" | "capacity" | "deadlines" | "leader" | "perf" | "pipeline";
export type Size = 1 | 2 | 3;
export type LayoutItem = [WidgetKey, Size];

const ALL: HomeRole[] = ["manager", "lead", "editor"];
const LEADS: HomeRole[] = ["manager", "lead"];

export type WidgetDef = { title: string; icon: string; roles: HomeRole[]; link?: { label: string; to: string } };
export const WIDGETS: Record<WidgetKey, WidgetDef> = {
  attend: { title: "Team today", icon: "how_to_reg", roles: LEADS, link: { label: "Attendance", to: "/my-team?tab=attendance" } },
  timer: { title: "My timer", icon: "timer", roles: ALL, link: { label: "Task board", to: "/tasks" } },
  upnext: { title: "My tasks", icon: "checklist", roles: ALL, link: { label: "Task board", to: "/tasks" } },
  mygoals: { title: "My goals", icon: "flag", roles: ["lead", "editor"], link: { label: "Goals", to: "/goals-board" } },
  reviews: { title: "Waiting for review", icon: "rate_review", roles: LEADS },
  team: { title: "Team right now", icon: "group", roles: LEADS, link: { label: "Team", to: "/my-team" } },
  goalpace: { title: "Team goal pace", icon: "track_changes", roles: LEADS, link: { label: "Goals", to: "/goals-board" } },
  capacity: { title: "Capacity", icon: "speed", roles: LEADS, link: { label: "Set goals", to: "/goals-board" } },
  deadlines: { title: "Due today & overdue", icon: "event_busy", roles: LEADS, link: { label: "Task board", to: "/tasks" } },
  leader: { title: "Leaderboard", icon: "trophy", roles: ALL, link: { label: "Leaderboard", to: "/leaderboard" } },
  perf: { title: "Content this week", icon: "monitoring", roles: ALL, link: { label: "Analytics", to: "/analytics" } },
  pipeline: { title: "Pipeline", icon: "movie", roles: ALL, link: { label: "Pipeline", to: "/metrics" } },
};
export const WIDGET_ORDER = Object.keys(WIDGETS) as WidgetKey[];

export const DEFAULT_LAYOUT: Record<HomeRole, LayoutItem[]> = {
  manager: [["attend", 2], ["deadlines", 1], ["reviews", 2], ["capacity", 1], ["goalpace", 2], ["team", 1], ["perf", 2], ["pipeline", 1]],
  lead: [["attend", 2], ["timer", 1], ["reviews", 2], ["deadlines", 1], ["goalpace", 2], ["mygoals", 1]],
  editor: [["timer", 1], ["upnext", 2], ["mygoals", 1], ["leader", 1], ["pipeline", 1]],
};

export const allowed = (k: WidgetKey, role: HomeRole) => WIDGETS[k].roles.includes(role);

// A stored layout, cleaned: known widgets the role may use, once each.
export function cleanLayout(raw: unknown, role: HomeRole): LayoutItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const it of raw) {
    if (!Array.isArray(it)) continue;
    const [k, s] = it as [string, number];
    if (!(k in WIDGETS) || seen.has(k) || !allowed(k as WidgetKey, role)) continue;
    seen.add(k);
    out.push([k as WidgetKey, (s === 2 || s === 3 ? s : 1) as Size]);
  }
  return out;
}
