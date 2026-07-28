export type NavSection = "Home" | "Analytics" | "Operations" | "Manage";

// Section order + which ones show a group label (Home is unlabeled — it's the
// landing item at the very top).
export const NAV_SECTIONS: { key: NavSection; label?: string }[] = [
  { key: "Home" },
  { key: "Analytics", label: "Analytics" },
  { key: "Operations", label: "Operations" },
  { key: "Manage", label: "Manage" },
];

export type NavItem = {
  title: string;
  href: string;
  icon: string;
  section: NavSection;
  showBadge?: boolean;
};

// Two pillars over a shared core: Analytics (content) + Operations (people).
export const NAV_ITEMS: NavItem[] = [
  { title: "Home", href: "/home", icon: "🏠", section: "Home" },
  { title: "Dashboard", href: "/dashboard", icon: "📊", section: "Analytics" },
  { title: "Insights", href: "/insights", icon: "💡", section: "Analytics" },
  { title: "Leaderboard", href: "/leaderboard", icon: "🏆", section: "Analytics" },
  { title: "Reports", href: "/reports", icon: "📄", section: "Analytics" },
  { title: "Editing Pipeline", href: "/metrics", icon: "📈", section: "Operations" },
  { title: "Task Board", href: "/tasks", icon: "✅", section: "Operations" },
  { title: "Add Post", href: "/posts/new", icon: "➕", section: "Manage" },
  { title: "Posts", href: "/posts", icon: "🗂️", section: "Manage", showBadge: true },
  { title: "Channels", href: "/channels", icon: "🌐", section: "Manage" },
  { title: "Settings", href: "/settings", icon: "⚙️", section: "Manage" },
];

// Page title + subtitle shown in the topbar, keyed by pathname.
export const PAGE_META: Record<string, [string, string]> = {
  "/home": ["Home", "What needs your attention today"],
  "/dashboard": ["Dashboard", "Live analytics from your content data"],
  "/metrics": ["Editing Progress", "Track every post through its editing pipeline across channels"],
  "/insights": ["Insights", "What your data is telling you — computed automatically"],
  "/leaderboard": ["Editor Leaderboard", "Editor performance & rankings from published posts"],
  "/reports": ["Reports", "Export and share performance summaries"],
  "/posts/new": ["Add Post", "Create the post record now — log its metrics after you publish"],
  "/posts": ["Posts", "Your content database — replaces the Manual Entry sheet"],
  "/channels": ["Channels & Platforms", "Add brand channels and choose which platforms each is on"],
  "/tasks": ["Task Management", "Assign and track your team's daily tasks"],
  "/settings": ["Settings", "Taxonomy, scoring weights, and team"],
  "/analytics": ["Format analytics", "Total performance across all posts of one format"],
};
