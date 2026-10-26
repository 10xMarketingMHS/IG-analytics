import { pool } from "./db.js";
import { isOrgAdmin } from "./permissions.js";
import { isSuperUser, superState } from "./super-admin.js";
import { positionKey } from "./attendance.js";

// Page access (Settings › Page access): what each position may see and change,
// page by page — a grid of positions (Team › Roster) against Echo's pages and
// settings. "See" puts a page in the person's menu and lets them open it;
// "Change" lets them use its buttons. A position's row takes effect once it's
// saved; until then its people keep today's rules (admins their admin pages).
// Saved, it's the rule for everyone in it, admins included — only the Super
// Admin is above it. Per-person grants (Settings › Access) come on top, and so
// does Scheduling for anyone with a Schedule goal. Kept in org.settings.pageAccess:
//   { rows: { teamLead: { pages: { chat: { see, change }, … }, savedAt, savedBy } } }

// The rows, most senior first; rank as in hierarchy.js (Senior, Editor and Junior share one).
export const ROWS = [
  { key: "manager", label: "Manager", rank: 0 },
  { key: "asstManager", label: "Asst. Manager", rank: 1 },
  { key: "teamLead", label: "Team Lead", rank: 2 },
  { key: "seniorEditor", label: "Senior Editor", rank: 3 },
  { key: "editor", label: "Editor", rank: 3 },
  { key: "juniorEditor", label: "Junior Editor", rank: 3 },
  { key: "viewer", label: "Viewer", rank: 4 },
];
const ROW = new Map(ROWS.map((r) => [r.key, r]));
export const rowByKey = (k) => ROW.get(k) ?? null;

// A person's row by their position — as hierarchy.js ranks them: an admin with
// no position (or an older title) sits at the top, anyone else with none is an editor.
export function rowOf(designation, isAdmin) {
  const k = positionKey(designation);
  if (k) return k;
  const p = String(designation || "").trim().toLowerCase();
  if (p === "senior editor") return "seniorEditor";
  if (p === "junior editor") return "juniorEditor";
  if (p === "editor") return "editor";
  if (p === "viewer") return "viewer";
  return isAdmin ? "manager" : "editor";
}

const ALL = ROWS.map((r) => r.key);
const WORKERS = ALL.filter((k) => k !== "viewer");
const LEADS = ["manager", "asstManager", "teamLead"];
const MANAGERS = ["manager", "asstManager"];
const NONE = [];

// The pages, in the sidebar's order, each with:
//   see:    true — a See tick; "on" — everyone, always (nobody is left with no page to land on)
//   change: true — a Change tick; false — nothing to change there; "super" — the Super Admin's alone
//   def:    today's rules for someone in that position who isn't an admin — what an unsaved row shows
//   does:   what Change lets them do, in a word or two (shown under the page's name)
export const PAGES = [
  { key: "home", group: "Home", label: "Home", see: "on", change: false },
  { key: "inbox", group: "Home", label: "Inbox", see: "on", change: false },
  { key: "chat", group: "Home", label: "Team Chat", see: true, change: true, does: "send messages", def: { see: WORKERS, change: WORKERS } },
  { key: "analytics", group: "Analytics", label: "Analytics", see: true, change: false, def: { see: ALL } },
  { key: "leaderboard", group: "Analytics", label: "Leaderboard", see: true, change: false, def: { see: ALL } },
  { key: "tasks", group: "Tasks", label: "Task Board", see: "on", change: true, does: "give others tasks", def: { change: NONE } },
  { key: "myTeam", group: "Tasks", label: "My Team", see: true, change: false, def: { see: NONE } },
  { key: "socialPipeline", group: "Social", label: "Pipeline", see: true, change: false, def: { see: ALL } },
  { key: "scheduling", group: "Social", label: "Scheduling", see: true, change: true, does: "date, link, assign", def: { see: LEADS, change: LEADS } },
  { key: "posts", group: "Social", label: "Posts", see: true, change: true, does: "add and edit posts", def: { see: ALL, change: WORKERS } },
  { key: "adsPipeline", group: "Ads", label: "Pipeline", see: true, change: false, def: { see: ALL } },
  { key: "uploads", group: "Ads", label: "Uploads", see: true, change: true, does: "record ad numbers", def: { see: LEADS, change: LEADS } },
  { key: "adsPerformance", group: "Ads", label: "Performance", see: true, change: true, does: "fill in results", def: { see: ALL, change: LEADS } },
  { key: "goals", group: "Manage", label: "Goals", see: true, change: true, does: "set people's goals", def: { see: ALL, change: NONE } },
  { key: "addPost", group: "Manage", label: "Add Post", see: true, change: false, def: { see: NONE } },
  { key: "knowledge", group: "Manage", label: "Knowledge Hub", see: true, change: true, does: "add and edit pages", def: { see: ALL, change: LEADS } },
  { key: "setGeneral", group: "Settings", label: "General", see: "on", change: true, does: "the workspace", def: { change: NONE } },
  { key: "setChannels", group: "Settings", label: "Channels", see: true, change: true, does: "brands, accounts", def: { see: NONE, change: NONE } },
  { key: "setContent", group: "Settings", label: "Content", see: true, change: true, does: "the content lists", def: { see: ALL, change: NONE } },
  { key: "setTasks", group: "Settings", label: "Tasks and time", see: true, change: true, does: "types, budgets, teams", def: { see: NONE, change: NONE } },
  { key: "setAttendance", group: "Settings", label: "Attendance", see: true, change: true, does: "start-of-day rules", def: { see: NONE, change: NONE } },
  { key: "setScoring", group: "Settings", label: "Scoring", see: true, change: "super", def: { see: NONE } },
  { key: "setNotifications", group: "Settings", label: "Notifications", see: "on", change: false },
  { key: "setWorkday", group: "Settings", label: "Work day", see: true, change: false, def: { see: NONE } },
  { key: "setApps", group: "Settings", label: "Connected apps", see: true, change: true, does: "make, revoke lines", def: { see: MANAGERS, change: MANAGERS } },
];
const PAGE = new Map(PAGES.map((p) => [p.key, p]));
export const pageByKey = (k) => PAGE.get(k) ?? null;

// A row's ticks made whole: locked pages on, Change only where a page has one
// (never the Super Admin's own), and Change brings See with it.
export function tidyRow(input = {}) {
  const out = {};
  for (const p of PAGES) {
    const i = input[p.key] ?? {};
    const change = p.change === true && !!i.change;
    out[p.key] = { see: p.see === "on" || !!i.see || change, change };
  }
  return out;
}
// What an unsaved row shows: today's rules for someone in it who isn't an admin.
export function defaultRow(rowKey) {
  const input = {};
  for (const p of PAGES) input[p.key] = { see: !!p.def?.see?.includes(rowKey), change: !!p.def?.change?.includes(rowKey) };
  return tidyRow(input);
}
// Everything on: the Super Admin's row.
export const fullRow = () => tidyRow(Object.fromEntries(PAGES.map((p) => [p.key, { see: true, change: true }])));

// The org's saved rows, briefly cached (a save clears it).
const gridCache = new Map(); // orgId -> { v, exp }
export async function gridOf(orgId) {
  const hit = gridCache.get(orgId);
  if (hit && hit.exp > Date.now()) return hit.v;
  const { rows } = await pool.query("select settings->'pageAccess'->'rows' as rows from org where id = $1", [orgId]);
  const v = rows[0]?.rows && typeof rows[0].rows === "object" ? rows[0].rows : {};
  gridCache.set(orgId, { v, exp: Date.now() + 5_000 });
  return v;
}
export const forgetGrid = (orgId) => gridCache.delete(orgId);

// The person asking: Super Admin or not, an admin or not, their row, and — when
// their row is saved — its ticks (null: today's rules still hold for them).
// Worked out once per request.
export async function callerAccess(req) {
  if (req.pageAccess) return req.pageAccess;
  // no workspace on the request (none of the grid's pages): today's rules
  if (!req.orgId) return { super: false, admin: req.role === "admin", row: null, rank: null, saved: false, pages: null };
  const admin = req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
  const [{ rows }, st, grid] = await Promise.all([
    pool.query("select e.designation from app_user u left join editor e on e.id = u.editor_id where u.id = $1", [req.user.sub]),
    admin ? superState(req.workspaceId) : null,
    gridOf(req.orgId),
  ]);
  const isSuper = admin && (await isSuperUser(req.user.sub, st));
  const row = rowOf(rows[0]?.designation, admin);
  const saved = grid[row];
  req.pageAccess = {
    super: isSuper, admin, row, rank: ROW.get(row).rank,
    saved: !!saved, pages: isSuper ? fullRow() : saved ? tidyRow(saved.pages) : null,
  };
  return req.pageAccess;
}

// May the caller see / change this page? The Super Admin always; a saved row by
// its tick; an unsaved one by today's rule (`legacy`, the check the route had
// before the grid — true, false, or a function of req).
export async function mayPage(req, key, mode, legacy) {
  const a = await callerAccess(req);
  if (a.super) return true;
  if (a.pages) return !!a.pages[key]?.[mode];
  return typeof legacy === "function" ? !!(await legacy(req)) : !!legacy;
}

export const NOT_YOUR_PAGE = "Your position doesn't have this. Ask an admin (Settings › Page access).";

// A route's page, checked: a saved row without the tick is refused; anyone else
// goes on to the route's own rules. "auto": See for reading, Change for the rest.
export function requirePage(key, mode = "auto") {
  return async (req, res, next) => {
    try {
      const m = mode === "auto" ? (req.method === "GET" ? "see" : "change") : mode;
      if (await mayPage(req, key, m, true)) return next();
      res.status(403).json({ error: NOT_YOUR_PAGE });
    } catch (err) {
      next(err);
    }
  };
}

// Which rows the caller may set: the Super Admin every one; an admin only those
// below their own position; anyone else none.
export function editableRows(a) {
  if (a.super) return ROWS.map((r) => r.key);
  if (!a.admin) return [];
  return ROWS.filter((r) => r.rank > a.rank).map((r) => r.key);
}
