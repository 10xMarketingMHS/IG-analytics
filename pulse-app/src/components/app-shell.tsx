import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { NAV_ITEMS, PAGE_META } from "@/lib/nav";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { usePosts } from "@/lib/use-posts";
import { useTheme } from "@/components/theme-provider";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

function metaFor(pathname: string): [string, string] {
  if (PAGE_META[pathname]) return PAGE_META[pathname];
  const hit = Object.keys(PAGE_META).find((k) => pathname.startsWith(k));
  return hit ? PAGE_META[hit] : ["Pulse", ""];
}

export function AppShell() {
  const { user, logout } = useAuth();
  const { active } = useWorkspaces();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const { posts } = usePosts();
  const postCount = posts?.length ?? null;
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const [title, sub] = metaFor(location.pathname);
  const initial = (user?.email ?? "?").charAt(0).toUpperCase();
  const sections: Array<"Analyze" | "Manage"> = ["Analyze", "Manage"];

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
          {sections.map((section) => (
            <div key={section}>
              <div className="navsec">{section}</div>
              {NAV_ITEMS.filter((i) => i.section === section).map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  end={item.href === "/posts"}
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
          <div className="avatar">{initial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nm">Admin</div>
            <div className="rl">{active?.name ?? "Pulse"}</div>
          </div>
          <button className="logout" title="Sign out" onClick={handleSignOut}>
            ⎋
          </button>
        </div>
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
          <WorkspaceSwitcher />
          <button className="btn icon" title="Theme" onClick={toggle}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button className="btn btn-primary add-post-btn" onClick={() => navigate("/posts/new")}>
            <span className="ap-plus">＋</span>
            <span className="ap-text"> Add Post</span>
          </button>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
