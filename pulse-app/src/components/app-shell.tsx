import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { NAV_ITEMS, NAV_SECTIONS, PAGE_META } from "@/lib/nav";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { usePosts } from "@/lib/use-posts";
import { useResource } from "@/lib/use-resource";
import { getActivitySeen, onActivitySeenChange } from "@/lib/activity-seen";
import { useTaskAssignNotify } from "@/lib/use-task-notify";
import { useOverdueTaskNotify } from "@/lib/use-overdue-notify";
import { BreakWidget } from "@/components/break-widget";
import { BreakOverlay } from "@/components/break-overlay";
import { MyProfileModal } from "@/components/my-profile-modal";
import { useTheme } from "@/components/theme-provider";
import type { Activity } from "@/lib/types";

// Unread = activity newer than the last timestamp the user saw on /activity.
// Polls lightly so the badge stays fresh while the shell stays mounted.
function useUnreadActivity() {
  const { data, refetch } = useResource<{ activity: Activity[] }>("/activity?limit=40");
  const [seen, setSeen] = useState(getActivitySeen());

  useEffect(() => onActivitySeenChange(() => setSeen(getActivitySeen())), []);
  useEffect(() => {
    const id = setInterval(() => refetch().catch(() => {}), 45_000);
    return () => clearInterval(id);
  }, [refetch]);

  return useMemo(() => {
    const items = data?.activity ?? [];
    if (!seen) return Math.min(items.length, 9);
    return items.filter((a) => a.created_at > seen).length;
  }, [data, seen]);
}

function metaFor(pathname: string): [string, string] {
  if (PAGE_META[pathname]) return PAGE_META[pathname];
  const hit = Object.keys(PAGE_META).find((k) => pathname.startsWith(k));
  return hit ? PAGE_META[hit] : ["Pulse", ""];
}

export function AppShell() {
  const { user, logout } = useAuth();
  const { active, isAdmin } = useWorkspaces();
  const { editors } = useEditors();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const { posts } = usePosts();
  const postCount = posts?.length ?? null;
  const unread = useUnreadActivity();
  useTaskAssignNotify();
  useOverdueTaskNotify();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

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

  async function handleSignOut() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className={"app" + (menuOpen ? " menu-open" : "")}>
      <div className="app-backdrop" onClick={() => setMenuOpen(false)} />
      <aside>
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
              {NAV_ITEMS.filter((i) => i.section === section.key && (!i.adminOnly || isAdmin)).map((item) => (
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
                  <span className="ic">{item.icon}</span> {item.title}
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
          <button className="logout" title="Sign out" onClick={handleSignOut}>
            ⎋
          </button>
        </div>
        {profileOpen && <MyProfileModal onClose={() => setProfileOpen(false)} />}
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
          <button
            className="btn icon bell-btn"
            title="Activity"
            aria-label="Activity"
            onClick={() => navigate("/activity")}
          >
            🔔
            {unread > 0 && <span className="bell-dot">{unread > 9 ? "9+" : unread}</span>}
          </button>
          <button className="btn icon" title="Theme" onClick={toggle}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {isAdmin && (
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
    </div>
  );
}
