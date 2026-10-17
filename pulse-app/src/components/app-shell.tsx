import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { NAV_ITEMS, NAV_SECTIONS, PAGE_META } from "@/lib/nav";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { usePosts } from "@/lib/use-posts";
import { useResource } from "@/lib/use-resource";
import { useAutoSync } from "@/lib/auto-sync";
import { getActivitySeen, onActivitySeenChange } from "@/lib/activity-seen";
import { hasSeenTask, useTaskAssignNotify } from "@/lib/use-task-notify";
import { useOverdueTaskNotify } from "@/lib/use-overdue-notify";
import { BreakWidget } from "@/components/break-widget";
import { BreakOverlay } from "@/components/break-overlay";
import { BreakProvider } from "@/lib/break-context";
import { useEodState } from "@/lib/eod-context";
import { MyProfileModal } from "@/components/my-profile-modal";
import { Modal } from "@/components/modal";
import { notifyTasksChanged } from "@/lib/task-events";
import { SodModal } from "@/components/sod-modal";
import { useTheme } from "@/components/theme-provider";
import { navIcon, SIGN_OUT_ICON } from "@/components/nav-icons";
import "./sidebar.css";
import type { Activity } from "@/lib/types";

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

export function AppShell() {
  const { user, logout } = useAuth();
  const { active, isAdmin, hasPermission } = useWorkspaces();
  // EOD lockout: an editor with no open session gets the whole shell grayscaled
  // and non-interactive (except a few live controls) until they Start EOD. The
  // grayscale/disable is CSS keyed off this class; see index.css `.eod-lock`.
  const {
    session: eodSession, loading: eodLoading, unlinked: eodUnlinked, summary: eodSummary,
    eodOpen, openEod, signOutAfter, clearSignOutAfter,
  } = useEodState();
  const eodLocked = active?.role === "editor" && !eodLoading && !eodUnlinked && !eodSession;
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
  // App-wide auto-sync: only ADMIN tabs poll (keeps the trigger surface small
  // with many users online); runs on any page while the tab is active, on the
  // org's interval. No-op unless an admin enabled the kill switch.
  useAutoSync(undefined, undefined, { active: isAdmin });
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // A locked editor can only act on My Day (it holds the live Start EOD button)
  // and the lock disables the nav, so landing anywhere else — sign-in, refresh,
  // an old link — would strand them on a dead page. Send them to My Day. The
  // one exception is Activity: notifications are read-only, so the bell keeps
  // working before clock-in (the topbar offers the way back, see below).
  const lockedOnActivity = eodLocked && location.pathname === "/activity";
  useEffect(() => {
    if (eodLocked && location.pathname !== "/home" && location.pathname !== "/activity") {
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
    <div className={"app" + (menuOpen ? " menu-open" : "") + (eodLocked ? " eod-lock" : "")}>
      <div className="app-backdrop" onClick={() => setMenuOpen(false)} />
      {/* sb2: the redesign's sidebar look (components/sidebar.css). */}
      <aside className="sb2">
        <div className="brand">
          <div className="logo">◐</div>
          <div>
            <b>Pulse</b>
            <small>Content Analytics</small>
          </div>
        </div>
        <nav className="side">
          {NAV_SECTIONS.map((section) => (
            <div key={section.key}>
              {section.label && <div className="navsec">{section.label}</div>}
              {NAV_ITEMS.filter((i) => i.section === section.key && (!i.adminOnly || isAdmin || (i.permission && hasPermission(i.permission)))).map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  end={item.href === "/posts"}
                  // Add Post opens as a modal over the current page.
                  state={
                    item.href === "/posts/new"
                      ? { backgroundLocation: location }
                      : undefined
                  }
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    "navitem" + (isActive ? " active" : "")
                  }
                >
                  <span className="ic">{navIcon(item.href) ?? item.icon}</span> {item.title}
                  {item.showBadge && postCount !== null && (
                    <span className="badge">{postCount}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
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
          <button className="logout" title="Sign out" aria-label="Sign out" onClick={handleSignOut}>
            {SIGN_OUT_ICON}
          </button>
        </div>
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
          {lockedOnActivity && (
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
      <BreakWidget />
      <BreakOverlay />
      <SodModal />
    </div>
    </BreakProvider>
  );
}
