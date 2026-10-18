import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { NAV_ITEMS, PAGE_META, type NavItem } from "@/lib/nav";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { usePosts } from "@/lib/use-posts";
import { useResource } from "@/lib/use-resource";
import { useAutoSync } from "@/lib/auto-sync";
import { getActivitySeen, onActivitySeenChange } from "@/lib/activity-seen";
import { hasSeenTask, useTaskAssignNotify } from "@/lib/use-task-notify";
import { useDueOverdueNotify, useOverdueTaskNotify, useReviewWaitingNotify } from "@/lib/use-overdue-notify";
import { scopeAllowsTask, useReviewAccess } from "@/lib/use-review-access";
import { useOrg } from "@/lib/use-org";
import { setWeekStart } from "@/lib/date-range";
import { ViewAsBar, ViewAsModal } from "@/components/view-as";
import { BreakWidget } from "@/components/break-widget";
import { BreakOverlay } from "@/components/break-overlay";
import { BreakProvider, useBreakState } from "@/lib/break-context";
import { useEodState } from "@/lib/eod-context";
import { MyProfileModal } from "@/components/my-profile-modal";
import { Modal } from "@/components/modal";
import { notifyTasksChanged } from "@/lib/task-events";
import { SodModal } from "@/components/sod-modal";
import { useTheme, ACCENTS } from "@/components/theme-provider";
import { ChatProvider, useChat } from "@/lib/chat";
import { navIcon, SIGN_OUT_ICON, RAIL_ICON, COMPOSE_ICON, SEARCH_ICON, PLUS_ICON, BREAK_ICON, GEAR_ICON, MORE_ICON } from "@/components/nav-icons";
import { JumpPalette, type JumpItem } from "@/components/jump-palette";
import { channelTile, initialsOf } from "@/lib/editor-visuals";
import "./sidebar.css";
import "./mobile.css";
import "./sheet.css";
import type { Account, Activity } from "@/lib/types";

// The sidebar's groups, as in the redesign. Items still come from NAV_ITEMS
// with their own access rules; Settings lives on the gear by your name and
// Add Post on the top bar, so neither is listed. Anything new in NAV_ITEMS
// that isn't placed here lands at the end of Operations.
const SIDEBAR_GROUPS: { label: string; hrefs: string[] }[] = [
  { label: "Workspace", hrefs: ["/home", "/chat", "/tasks", "/analytics"] },
  { label: "Operations", hrefs: ["/metrics", "/posts", "/leaderboard", "/goals-board", "/my-team"] },
];
const OFF_SIDEBAR = new Set(["/settings", "/posts/new"]);
// Before Start Work an editor can still open these — Settings shows only what
// their permissions allow, Goals only their own — and the rest (Pipeline,
// Posts, Leaderboard) wait for it. Their links stay live in the sidebar and tab bar.
const OPEN_WHEN_LOCKED = new Set(["/home", "/activity", "/chat", "/tasks", "/analytics", "/goals-board", "/settings", "/channels", "/task-rules"]);
const LIVE_WHEN_LOCKED = new Set(["/home", "/chat", "/tasks", "/analytics", "/goals-board"]);
const openWhenLocked = (path: string) => OPEN_WHEN_LOCKED.has(path) || path.startsWith("/analytics/");
const RAIL_KEY = "pulse-sidebar-rail";
// The phone tab bar has ~54px a tab: two names go short there (the sidebar and
// page titles keep them in full).
const TAB_SHORT: Record<string, string> = { "/chat": "Chat", "/tasks": "Tasks" };
const PLATFORM_DOT: Record<string, string> = { instagram: "#e1306c", facebook: "#1877f2", youtube: "#ff0033" };

// Break time used today, for anyone whose breaks are tracked (an employee
// who's clocked in, or anyone on a break right now) — the same people the
// Task Board's break button is for. Display only; that button starts/ends it.
// Break time used today, always in view above you (as in the design): the
// bar fills as the day's 75 minutes go; on a break it turns amber. A login
// not linked to a team member has no breaks to track, and says so.
function SidebarBreak() {
  const { status, displayRemaining } = useBreakState();
  if (!status) return null;
  if (status.unlinked) {
    return (
      <div className="sb2-break off" title="Breaks are tracked for logins linked to a team member (Team › Roster).">
        {BREAK_ICON}
        <span className="sb2-label">Break</span>
        <span className="sb2-break-off sb2-label">Not tracked</span>
      </div>
    );
  }
  const cap = Math.max(60, status.dailyCapSeconds);
  const remaining = Math.min(cap, Math.max(0, displayRemaining ?? status.remainingSeconds));
  const used = cap - remaining;
  const usedMin = Math.round(used / 60), leftMin = Math.round(remaining / 60);
  return (
    <div className={"sb2-break" + (status.onBreak ? " on" : "")}
      title={status.onBreak ? `On a break: ${leftMin} min left today. Your task timers are paused.` : `${usedMin} of ${Math.round(cap / 60)} min of break used today, ${leftMin} min left`}>
      {BREAK_ICON}
      <span className="sb2-label">{status.onBreak ? "On break" : "Break"}</span>
      <span className="sb2-bar sb2-label"><span style={{ width: `${((100 * used) / cap).toFixed(1)}%` }} /></span>
      <span className="sb2-break-n sb2-label">{Math.round(used / 60)}/{Math.round(cap / 60)}m</span>
    </div>
  );
}

// Unread = activity newer than the last timestamp the user saw on /activity.
// Polls lightly so the badge stays fresh while the shell stays mounted.
function useUnreadActivity() {
  const { data, refetch } = useResource<{ activity: Activity[] }>("/activity?limit=40");
  const [seen, setSeen] = useState(getActivitySeen());

  useEffect(() => onActivitySeenChange(() => setSeen(getActivitySeen())), []);
  useEffect(() => {
    const id = setInterval(() => refetch().catch(() => {}), 20_000);
    return () => clearInterval(id);
  }, [refetch]);

  const unread = useMemo(() => {
    const items = data?.activity ?? [];
    if (!seen) return Math.min(items.length, 9);
    return items.filter((a) => a.created_at > seen).length;
  }, [data, seen]);
  return { unread, items: data?.activity };
}

// Live notices: when someone else approves, sends back, reopens, moves, holds or
// deletes one of your tasks — or, for a reviewer, submits one — say so as it
// happens and reload every task list, instead of leaving the board on its old
// stage until the page changes. Only entries newer than this tab's first look
// count.
const LIVE_VERBS = new Set([
  "completed", "sent_back", "reopened", "assigned", "deleted", "held", "resumed",
  "review_requested", "password_reset_requested", "sod_submitted",
]);
function useLiveNotices(items: Activity[] | undefined, myId: string | undefined, myEditorId: string | null | undefined) {
  const since = useRef<string | null>(null);
  useEffect(() => {
    if (!items) return;
    const newest = items[0]?.created_at ?? new Date().toISOString();
    if (since.current === null) { since.current = newest; return; }
    const fresh = items.filter((a) => a.created_at > since.current! && a.actor_id !== myId);
    if (newest > since.current) since.current = newest;
    if (!fresh.length) return;
    for (const a of [...fresh].reverse()) {
      if (!LIVE_VERBS.has(a.verb)) continue;
      // A task newly handed to you is announced by useTaskAssignNotify ("New
      // task"); one that comes back after you had it before is announced here.
      if (a.verb === "assigned" && myEditorId && a.meta?.toEditorId === myEditorId
          && myId && a.entity_id && !hasSeenTask(myId, a.entity_id)) continue;
      const summary = a.summary.charAt(0).toLowerCase() + a.summary.slice(1);
      const note = a.verb === "sent_back" && typeof a.meta?.note === "string" ? a.meta.note : undefined;
      toast(`🔔 ${a.actor_name ?? "Someone"} ${summary}`, { description: note });
    }
    if (fresh.some((a) => a.entity_type === "task")) notifyTasksChanged();
  }, [items, myId, myEditorId]);
}

function metaFor(pathname: string): [string, string] {
  if (PAGE_META[pathname]) return PAGE_META[pathname];
  const hit = Object.keys(PAGE_META).find((k) => pathname.startsWith(k));
  return hit ? PAGE_META[hit] : ["Pulse", ""];
}

// Team chat's live stream and unread counts live for as long as you're signed
// in, so a DM or mention reaches you on any page — see lib/chat.tsx.
export function AppShell() {
  return (
    <ChatProvider>
      <AppShellInner />
    </ChatProvider>
  );
}

// The sidebar's Team Chat count: red for @mentions and unread DMs, a quiet dot
// when only channel messages are waiting.
// The accent colour picker in the top bar: violet, blue or green tints the
// background and every highlight (index.css --acH).
function AccentPicker() {
  const { accent, setAccent } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const cur = ACCENTS.find((a) => a.key === accent) ?? ACCENTS[0];
  return (
    <div className="accent-pick" ref={ref}>
      <button type="button" className="btn icon" title="Accent colour" aria-label={`Accent colour: ${cur.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="accent-dot" style={{ background: cur.swatch }} />
      </button>
      {open && (
        <div className="accent-pop" role="menu" aria-label="Accent colour">
          <b>Accent colour</b>
          <div className="accent-grid">
            {ACCENTS.map((a) => (
              <button key={a.key} type="button" role="menuitemradio" aria-checked={accent === a.key} aria-label={a.label} title={a.label}
                className={accent === a.key ? "on" : ""} onClick={() => setAccent(a.key)}>
                <span className="accent-tile" style={{ background: a.swatch }}>
                  {accent === a.key && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </span>
                <span className="accent-name">{a.label}</span>
              </button>
            ))}
          </div>
          <span className="accent-note">Tints the background and highlights. Only for you, on this browser.</span>
        </div>
      )}
    </div>
  );
}

// Phones: the same choice as three dots in the More menu, so the top bar keeps room for the page name.
function AccentRow() {
  const { accent, setAccent } = useTheme();
  return (
    <div className="sb2-accent" role="radiogroup" aria-label="Accent colour">
      <span>Accent colour</span>
      <div>
        {ACCENTS.map((a) => (
          <button key={a.key} type="button" role="radio" aria-checked={accent === a.key} aria-label={a.label} title={a.label}
            className={accent === a.key ? "on" : ""} onClick={() => setAccent(a.key)}>
            <span className="accent-tile" style={{ background: a.swatch }} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBadge() {
  const { totals } = useChat();
  if (totals.alerts > 0) return <span className="badge alert">{totals.alerts > 99 ? "99+" : totals.alerts}</span>;
  if (totals.unread > 0) return <span className="badge dot" aria-label="Unread messages" />;
  return null;
}

function AppShellInner() {
  const { user, logout } = useAuth();
  const { available: chatAvailable } = useChat();
  const { active, workspaces, isAdmin, hasPermission } = useWorkspaces();
  // EOD lockout: an editor with no open session gets the whole shell grayscaled
  // and non-interactive (except a few live controls) until they Start EOD. The
  // grayscale/disable is CSS keyed off this class; see index.css `.eod-lock`.
  const {
    session: eodSession, loading: eodLoading, unlinked: eodUnlinked, summary: eodSummary,
    eodOpen, openEod, signOutAfter, clearSignOutAfter,
  } = useEodState();
  // Viewing as someone is look-only, so their Start Work lock doesn't apply.
  const eodLocked = !user?.viewingAs && active?.role === "editor" && !eodLoading && !eodUnlinked && !eodSession;
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const { editors } = useEditors();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const { posts } = usePosts();
  const postCount = posts?.length ?? null;
  const { unread, items: activityItems } = useUnreadActivity();
  useLiveNotices(activityItems, user?.id, user?.editorId);
  useTaskAssignNotify();
  useOverdueTaskNotify();
  useDueOverdueNotify();
  // Anyone who reviews hears when work lands in review (within their scope).
  const review = useReviewAccess();
  useReviewWaitingNotify(isAdmin || review.granted, (t) => isAdmin || scopeAllowsTask(review.scope, t));
  // The organisation's name (sidebar) and week start (date ranges).
  const { org } = useOrg();
  useEffect(() => { if (org) setWeekStart(org.weekStart); }, [org?.weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  // App-wide auto-sync: only ADMIN tabs poll (keeps the trigger surface small
  // with many users online); runs on any page while the tab is active, on the
  // org's interval. No-op unless an admin enabled the kill switch.
  useAutoSync(undefined, undefined, { active: isAdmin });
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Sidebar: collapsed to an icon rail (remembered on this device), and the
  // Search or jump to… palette (also Ctrl/⌘ K).
  const [rail, setRail] = useState(() => { try { return window.localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } });
  // Collapsing or expanding glides in one motion — sidebar.css does it all.
  function toggleRail() {
    setRail((r) => {
      try { window.localStorage.setItem(RAIL_KEY, r ? "0" : "1"); } catch { /* fine, just not remembered */ }
      return !r;
    });
  }
  const [jumpOpen, setJumpOpen] = useState(false);
  const canWrite = active?.role !== "viewer";
  const canSee = (i: NavItem) => (!i.adminOnly || isAdmin || (!!i.permission && hasPermission(i.permission))) && (!i.chatBadge || chatAvailable);
  const placed = new Set(SIDEBAR_GROUPS.flatMap((g) => g.hrefs));
  const sideGroups = SIDEBAR_GROUPS.map((g, gi) => ({
    label: g.label,
    items: [
      ...g.hrefs.map((h) => NAV_ITEMS.find((i) => i.href === h)),
      ...(gi === SIDEBAR_GROUPS.length - 1 ? NAV_ITEMS.filter((i) => !placed.has(i.href) && !OFF_SIDEBAR.has(i.href)) : []),
    ].filter((i): i is NavItem => !!i && canSee(i)),
  }));
  // The phone tab bar: the Workspace places you can see; More lights up anywhere else.
  const tabItems = (sideGroups[0]?.items ?? []).slice(0, 4);
  const onTab = tabItems.some((i) => location.pathname === i.href || location.pathname.startsWith(i.href + "/"));
  // Channels: each brand with a dot per platform it posts to.
  const { data: acctData } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const platformsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of acctData?.accounts ?? []) {
      if (!m.has(a.channel_id)) m.set(a.channel_id, new Set());
      m.get(a.channel_id)!.add(a.platform_key);
    }
    return m;
  }, [acctData]);
  const addPostItem = NAV_ITEMS.find((i) => i.href === "/posts/new");
  const settingsItem = NAV_ITEMS.find((i) => i.href === "/settings");
  const jumpItems: JumpItem[] = [
    ...sideGroups.flatMap((g) => g.items.map((i) => ({ title: i.title, href: i.href, icon: navIcon(i.href) ?? i.icon, group: g.label }))),
    ...(addPostItem && canSee(addPostItem) ? [{ title: addPostItem.title, href: addPostItem.href, icon: navIcon(addPostItem.href) ?? addPostItem.icon, group: "Create", state: { backgroundLocation: location } }] : []),
    ...(settingsItem ? [{ title: settingsItem.title, href: settingsItem.href, icon: GEAR_ICON, group: "Account" }] : []),
  ];

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Ctrl/⌘ K opens Search or jump to… (not while the day is locked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!eodLocked) setJumpOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [eodLocked]);

  // A locked editor can only act on My Day (it holds the live Start EOD button)
  // and the lock disables the nav, so landing anywhere else — sign-in, refresh,
  // an old link — would strand them on a dead page. Send them to My Day. The
  // exceptions (OPEN_WHEN_LOCKED): Activity, Team Chat, the Task Board,
  // Analytics, Goals and Settings. Each gets a way back in the top bar, see below.
  const lockedOnOpenPage = eodLocked && openWhenLocked(location.pathname) && location.pathname !== "/home";
  useEffect(() => {
    if (eodLocked && !openWhenLocked(location.pathname)) {
      navigate("/home", { replace: true });
    }
  }, [eodLocked, location.pathname, navigate]);

  const [title, sub] = metaFor(location.pathname);
  const initial = (user?.name || user?.email || "?").charAt(0).toUpperCase();
  // Prefer the person's actual designation (Team Lead, Manager, Video
  // Editor…) from their linked roster record over the generic account role —
  // "Admin" under your name reads like a job title, which it isn't. Falls
  // back to the role for anyone not on the roster (viewers/editors only —
  // an admin with no designation gets the glow ring below instead of text).
  const myDesignation = editors?.find((e) => e.id === user?.editorId)?.designation || null;
  const roleLabel = active?.role ? active.role.charAt(0).toUpperCase() + active.role.slice(1) : "Member";
  const subtitle = myDesignation || (isAdmin ? null : roleLabel);

  // Signing out doesn't end the work day (someone may just be switching
  // devices), so a clocked-in employee is asked which they mean.
  const [signOutAsk, setSignOutAsk] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  async function handleSignOut() {
    if (active?.role === "editor" && eodSession) { setSignOutAsk(true); return; }
    await signOut(false);
  }
  // "End Work and sign out" goes through the End of Day window (notes, then
  // End Work) and the day's summary; closing the summary finishes the sign-out.
  // Closing the window without ending cancels it.
  async function signOut(endWorkFirst: boolean) {
    setSignOutAsk(false);
    if (endWorkFirst) {
      openEod(true);
      return;
    }
    setSigningOut(true);
    await logout();
    navigate("/login", { replace: true });
  }
  useEffect(() => {
    if (!signOutAfter || eodOpen || eodSession || eodSummary) return;
    clearSignOutAfter();
    logout().then(() => navigate("/login", { replace: true }));
  }, [signOutAfter, eodOpen, eodSession, eodSummary, clearSignOutAfter, logout, navigate]);

  return (
    <BreakProvider>
    <div className={"app" + (menuOpen ? " menu-open" : "") + (eodLocked ? " eod-lock" : "") + (lockedOnOpenPage ? " lock-page-open" : "") + (rail ? " sb-rail" : "")}>
      <div className="app-backdrop" onClick={() => setMenuOpen(false)} />
      {/* sb2: the redesign's sidebar (components/sidebar.css) — brand and
          collapse, search and new task, the Workspace / Operations groups,
          your channels, then break time and you. */}
      <aside className="sb2">
        <div className="brand">
          {user?.isSuperAdmin && !user.viewingAs ? (
            <button type="button" className="logo" onClick={() => setViewAsOpen(true)} title="View Pulse as someone (test)" aria-label="View Pulse as someone">◐</button>
          ) : (
            <div className="logo">◐</div>
          )}
          <div className="sb2-label sb2-brandtx">
            <b>Pulse</b>
            <small>{org?.name || "Content Analytics"}</small>
          </div>
          <button type="button" className="sb2-iconbtn sb2-railbtn" onClick={toggleRail} aria-pressed={rail}
            title={rail ? "Expand the sidebar" : "Collapse the sidebar"} aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"}>
            {RAIL_ICON}
          </button>
        </div>
        <div className="sb2-tools">
          {/* folded rail only: the search box becomes a tile above New task */}
          <button type="button" className="sb2-railsearch" onClick={() => setJumpOpen(true)} title="Search or jump to… (Ctrl K)" aria-label="Search or jump to">
            {SEARCH_ICON}
          </button>
          <button type="button" className="sb2-search" onClick={() => setJumpOpen(true)} title="Search or jump to… (Ctrl K)" aria-label="Search or jump to">
            {SEARCH_ICON}<span className="sb2-label">Search</span><kbd className="sb2-label">Ctrl K</kbd>
          </button>
          {canWrite && (
            <button type="button" className="sb2-compose" title="New task" aria-label="New task"
              onClick={() => { setMenuOpen(false); navigate("/tasks", { state: { newTask: true } }); }}>
              {COMPOSE_ICON}
            </button>
          )}
        </div>
        <nav className="side">
          {sideGroups.filter((g) => g.items.length > 0).map((g) => (
            <div key={g.label} className="sb2-group">
              <div className="navsec"><span className="sb2-label">{g.label}</span></div>
              {g.items.map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  end={item.href === "/posts"}
                  title={rail ? item.title : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    "navitem" + (isActive ? " active" : "") + (eodLocked && LIVE_WHEN_LOCKED.has(item.href) ? " eod-live" : "")
                  }
                >
                  <span className="ic">{navIcon(item.href) ?? item.icon}</span> <span className="sb2-label">{item.title}</span>
                  {item.showBadge && postCount !== null && (
                    <span className="badge">{postCount}</span>
                  )}
                  {item.chatBadge && <ChatBadge />}
                </NavLink>
              ))}
            </div>
          ))}
          {workspaces.length > 0 && (
            <div className="sb2-group sb2-channels">
              <div className="navsec">
                <span className="sb2-label">Channels</span>
                {isAdmin && (
                  <NavLink to="/channels" className="sb2-secbtn" title="Add or edit channels" aria-label="Add or edit channels" onClick={() => setMenuOpen(false)}>{PLUS_ICON}</NavLink>
                )}
              </div>
              {workspaces.map((w) => (
                <button key={w.id} type="button" className="navitem sb2-channel" title={rail ? w.name : `${w.name} — see its posts`}
                  onClick={() => { setMenuOpen(false); navigate("/posts", { state: { channel: w.id } }); }}>
                  <span className="ic sb2-chtile" style={w.logo_url ? undefined : { backgroundColor: channelTile(w.id) }}>
                    {w.logo_url ? <img src={w.logo_url} alt="" /> : initialsOf(w.name)}
                  </span>
                  <span className="sb2-label">{w.name}</span>
                  <span className="sb2-plats sb2-label">
                    {[...(platformsOf.get(w.id) ?? [])].map((p) => <span key={p} title={p} style={{ background: PLATFORM_DOT[p] ?? "currentColor" }} />)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </nav>
        <SidebarBreak />
        <AccentRow />
        <div className="userchip">
          <button
            type="button"
            className="userchip-open"
            title="My Profile"
            onClick={() => setProfileOpen(true)}
            style={{ all: "unset", display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, cursor: "pointer" }}
          >
            {/* Admin gets a glow ring instead of an "Admin" text label — same
                idea as a verified/paid-tier ring elsewhere (Gmail, etc.). */}
            <div className={"avatar-ring" + (isAdmin ? " admin" : "")}>
              <div className="avatar" style={{ background: user?.imageUrl ? undefined : (user?.color ?? undefined), overflow: "hidden" }}>
                {user?.imageUrl ? <img src={user.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initial}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <div className="nm">{user?.name || user?.email || "Account"}</div>
              {subtitle && <div className="rl">{subtitle}</div>}
            </div>
          </button>
          {settingsItem && (
            <NavLink to={settingsItem.href} className={({ isActive }) => "sb2-iconbtn sb2-gear" + (isActive ? " active" : "")}
              title="Settings" aria-label="Settings" onClick={() => setMenuOpen(false)}>
              {GEAR_ICON}
            </NavLink>
          )}
          <button className="logout" title="Sign out" aria-label="Sign out" onClick={handleSignOut}>
            {SIGN_OUT_ICON}
          </button>
        </div>
        {jumpOpen && <JumpPalette items={jumpItems} onClose={() => setJumpOpen(false)} />}
        {profileOpen && <MyProfileModal onClose={() => setProfileOpen(false)} />}
        {signOutAsk && (
          <Modal title="You're still clocked in" onClose={() => setSignOutAsk(false)}>
            <p style={{ margin: "0 0 14px", lineHeight: 1.5 }}>
              Signing out doesn't end your work day. End Work now, or stay clocked in if you're just switching to
              another device.
            </p>
            <div className="formfoot">
              <button className="btn" disabled={signingOut} onClick={() => setSignOutAsk(false)}>Cancel</button>
              <button className="btn" disabled={signingOut} onClick={() => signOut(false)}>Sign out, stay clocked in</button>
              <button className="btn btn-primary" disabled={signingOut} onClick={() => signOut(true)}>
                {signingOut ? "Signing out…" : "End Work and sign out"}
              </button>
            </div>
          </Modal>
        )}
      </aside>

      <main>
        <div className="topbar">
          <button
            className="btn icon menu-btn"
            title="Menu"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </button>
          <div className="topbar-title">
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
          <div className="spacer" />
          {lockedOnOpenPage && (
            <button className="btn" onClick={() => navigate("/home")}>← My Day</button>
          )}
          {/* The bell is a toggle: it opens Activity, and pressed again there it
              returns to My Day — the Activity page has no other way back. */}
          <button
            className={"btn icon bell-btn" + (location.pathname === "/activity" ? " on" : "")}
            title={location.pathname === "/activity" ? "Back to My Day" : "Activity"}
            aria-label={location.pathname === "/activity" ? "Back to My Day" : "Activity"}
            aria-pressed={location.pathname === "/activity"}
            onClick={() => navigate(location.pathname === "/activity" ? "/home" : "/activity")}
          >
            🔔
            {unread > 0 && <span className="bell-dot">{unread > 9 ? "9+" : unread}</span>}
          </button>
          <AccentPicker />
          <button className="btn icon" title="Theme" onClick={toggle}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {(isAdmin || hasPermission("create_post")) && (
            <button
              className="btn btn-primary add-post-btn"
              onClick={() => navigate("/posts/new", { state: { backgroundLocation: location } })}
            >
              <span className="ap-plus">＋</span>
              <span className="ap-text"> Add Post</span>
            </button>
          )}
        </div>
        <div className="content">
          <Outlet />
        </div>
      </main>
      {/* Phones: an app-style tab bar (components/mobile.css) — the four
          Workspace places and More for the full menu, in a floating pill, with
          New task as a round button beside it. */}
      <nav className={"tabbar" + (canWrite ? " has-fab" : "")} aria-label="Main">
        {tabItems.map((item) => (
          <NavLink key={item.href} to={item.href} aria-label={item.title} className={({ isActive }) => "tab" + (isActive && !menuOpen ? " on" : "") + (eodLocked && LIVE_WHEN_LOCKED.has(item.href) ? " eod-live" : "")} onClick={() => setMenuOpen(false)}>
            <span className="tab-ic">{navIcon(item.href) ?? item.icon}{item.chatBadge && <ChatBadge />}</span>
            <span className="tab-l" aria-hidden="true">{TAB_SHORT[item.href] ?? item.title}</span>
          </NavLink>
        ))}
        <button type="button" className={"tab" + (menuOpen || !onTab ? " on" : "")} onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-label="More: the full menu">
          <span className="tab-ic">{MORE_ICON}</span>
          <span className="tab-l">More</span>
        </button>
      </nav>
      {canWrite && (
        <button type="button" className="tab-fab" title="New task" aria-label="New task"
          onClick={() => { setMenuOpen(false); navigate("/tasks", { state: { newTask: true } }); }}>
          {PLUS_ICON}
        </button>
      )}
      <BreakWidget />
      <BreakOverlay />
      <SodModal />
      {viewAsOpen && <ViewAsModal onClose={() => setViewAsOpen(false)} />}
      {user?.viewingAs && <ViewAsBar name={user.name || user.email} realName={user.viewingAs.name} />}
    </div>
    </BreakProvider>
  );
}
