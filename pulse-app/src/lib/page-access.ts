// Page access (Settings › Page access; server/src/page-access.js): what each
// position may see and change, page by page. A position's row decides once it's
// saved; until then today's rules hold. Keep the keys in sync with the server's PAGES.
import type { PermissionKey } from "@/lib/workspaces-context";

export type PageKey =
  | "home" | "inbox" | "chat" | "analytics" | "leaderboard" | "tasks" | "myTeam"
  | "socialPipeline" | "scheduling" | "posts" | "adsPipeline" | "uploads" | "adsPerformance"
  | "goals" | "addPost"
  | "setGeneral" | "setChannels" | "setContent" | "setTasks" | "setAttendance" | "setScoring" | "setNotifications" | "setWorkday" | "setApps";
export type PageTicks = Record<PageKey, { see: boolean; change: boolean }>;
// /page-access/me — pages null: the row isn't saved, so today's rules hold
export type PageAccess = { super: boolean; row: string; saved: boolean; pages: PageTicks | null };

// The Access grants that stand for a page's tick (Change, or Add Post's See).
export const PERM_PAGE: Partial<Record<PermissionKey, { key: PageKey; mode: "see" | "change" }>> = {
  channels: { key: "setChannels", mode: "change" },
  content_taxonomy: { key: "setContent", mode: "change" },
  task_settings: { key: "setTasks", mode: "change" },
  edit_goals: { key: "goals", mode: "change" },
  assign_tasks: { key: "tasks", mode: "change" },
  create_post: { key: "addPost", mode: "see" },
};

// The sidebar's pages (Social's and Ads' are their tabs, lib/sections.ts).
export const NAV_PAGE: Record<string, PageKey> = {
  "/home": "home", "/inbox": "inbox", "/chat": "chat", "/analytics": "analytics", "/leaderboard": "leaderboard",
  "/tasks": "tasks", "/my-team": "myTeam", "/scheduling": "scheduling", "/posts": "posts", "/ad-uploads": "uploads",
  "/ads-performance": "adsPerformance", "/goals-board": "goals", "/posts/new": "addPost",
};

// Which page an address is — any one of them lets it open — or null for one
// outside the grid (Settings answers for its own sections).
export function pagesAt(pathname: string, search: string): PageKey[] | null {
  if (pathname === "/metrics") {
    const t = new URLSearchParams(search).get("type");
    return t === "ad" ? ["adsPipeline"] : t === "social" ? ["socialPipeline"] : ["socialPipeline", "adsPipeline"];
  }
  if (pathname === "/teams") return ["myTeam"];
  if (pathname.startsWith("/analytics/")) return ["analytics"];
  if (/^\/posts\/(?!new$)[^/]+/.test(pathname)) return ["posts"];
  const k = NAV_PAGE[pathname];
  return k ? [k] : null;
}
