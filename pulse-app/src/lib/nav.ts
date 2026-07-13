export type NavItem = {
  title: string;
  href: string;
  icon: string;
  section: "Analyze" | "Manage";
  showBadge?: boolean;
};

// PRD §13 / mockup — grouped Analyze · Manage
export const NAV_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: "📊", section: "Analyze" },
  { title: "Insights", href: "/insights", icon: "💡", section: "Analyze" },
  { title: "Leaderboard", href: "/leaderboard", icon: "🏆", section: "Analyze" },
  { title: "Reports", href: "/reports", icon: "📄", section: "Analyze" },
  { title: "Add Post", href: "/posts/new", icon: "➕", section: "Manage" },
  { title: "Posts", href: "/posts", icon: "🗂️", section: "Manage", showBadge: true },
  { title: "Settings", href: "/settings", icon: "⚙️", section: "Manage" },
];

// Page title + subtitle shown in the topbar, keyed by pathname.
export const PAGE_META: Record<string, [string, string]> = {
  "/dashboard": ["Dashboard", "Live analytics from your content data"],
  "/insights": ["Insights", "What your data is telling you — computed automatically"],
  "/leaderboard": ["Editor Leaderboard", "Editor performance & rankings from published posts"],
  "/reports": ["Reports", "Export and share performance summaries"],
  "/posts/new": ["Add Post", "Create the post record now — log its metrics after you publish"],
  "/posts": ["Posts", "Your content database — replaces the Manual Entry sheet"],
  "/settings": ["Settings", "Taxonomy, scoring weights, and team"],
  "/analytics": ["Format analytics", "Total performance across all posts of one format"],
};
