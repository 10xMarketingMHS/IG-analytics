export type NavSection = "Home" | "Analytics" | "Tasks" | "Manage";

// Section order + which ones show a group label (Home is unlabeled — it's the
// landing item at the very top).
export const NAV_SECTIONS: { key: NavSection; label?: string }[] = [
  { key: "Home" },
  { key: "Tasks", label: "Tasks" },
  { key: "Analytics", label: "Analytics" },
  { key: "Manage", label: "Manage" },
];

export type NavItem = {
  title: string;
  href: string;
  icon: string;
  section: NavSection;
  showBadge?: boolean;
  // Hidden from the sidebar (and its topbar shortcut, where one exists) for
  // anyone who isn't an admin.
  adminOnly?: boolean;
  // An adminOnly item may also be shown to holders of this permission grant
  // (Settings → Access) — e.g. Add Post for a create_post grantee.
  permission?: "create_post" | "goal_setting_access";
  // Team Chat: carries the unread/mention badge, and is hidden from anyone
  // chat isn't for (viewers).
  chatBadge?: boolean;
  // Inbox: carries how many requests wait on you
  inboxBadge?: boolean;
  // Scheduling: only for this month's schedulers (a Schedule goal), Managers and Team Leads
  schedulerOnly?: boolean;
  // Ad uploads: only for the Managers and Team Leads; carries how many wait
  uploadsOnly?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  // "Home" — a personalized daily brief (what needs *your* attention),
  // distinct from Dashboard, which shows the same org-wide analytics to
  // everyone. Shown as "My Day" until 2026-10-17; the route was always /home.
  { title: "Home", href: "/home", icon: "🏠", section: "Home" },
  // Inbox — everything waiting on you (leave, permissions, corrections,
  // hand-overs, reviews, tasks to accept, password resets) and what you sent.
  { title: "Inbox", href: "/inbox", icon: "📥", section: "Home", inboxBadge: true },
  { title: "Team Chat", href: "/chat", icon: "💬", section: "Home", chatBadge: true },
  // Analytics — the Dashboard and Top Performers merged into one page with an
  // Overview tab and a Top performers tab (/dashboard and /top redirect here).
  // Insights, Trends, Reports — hidden from the sidebar per request; routes/
  // pages still exist (see App.tsx, PAGE_META below), just not linked.
  { title: "Analytics", href: "/analytics", icon: "📈", section: "Analytics" },
  { title: "Leaderboard", href: "/leaderboard", icon: "🏆", section: "Analytics" },
  { title: "Task Board", href: "/tasks", icon: "✅", section: "Tasks" },
  // My Team — admin-only: everyone ranked for a date range, with their tasks.
  { title: "My Team", href: "/my-team", icon: "🏅", section: "Tasks", adminOnly: true },
  { title: "Social & Ads Pipeline", href: "/metrics", icon: "🎬", section: "Tasks" },
  // Scheduling — approved reels, carousels and posts for the schedulers to date and link.
  { title: "Scheduling", href: "/scheduling", icon: "🗓️", section: "Tasks", schedulerOnly: true },
  // Ad uploads — approved ads, by team, for the Managers and Team Leads to record the ads each became.
  { title: "Ad uploads", href: "/ad-uploads", icon: "📣", section: "Tasks", uploadsOnly: true },
  // Ads performance — everyone: every ad, with its results, per editor and per team.
  { title: "Ads performance", href: "/ads-performance", icon: "📊", section: "Tasks" },
  // Social Media, Activity — hidden from the sidebar per request; routes/
  // pages still exist.
  { title: "Add Post", href: "/posts/new", icon: "➕", section: "Manage", adminOnly: true, permission: "create_post" },
  // Goals — admin-only manual goal-tracking dashboard (its own page, not a
  // Settings tab). Any admin can see and manage any goal.
  { title: "Goals", href: "/goals-board", icon: "🎯", section: "Manage" },
  { title: "Posts", href: "/posts", icon: "🗂️", section: "Manage", showBadge: true },
  // Task Settings, Channels, and Teams are tabs inside Settings now, not
  // separate sidebar links — one place for all admin configuration.
  { title: "Settings", href: "/settings", icon: "⚙️", section: "Manage" },
];

// Page title + subtitle shown in the topbar, keyed by pathname.
export const PAGE_META: Record<string, [string, string]> = {
  "/home": ["Home", "What needs your attention today"],
  "/inbox": ["Inbox", "Everything waiting on you, and what you sent"],
  "/leave": ["Leave", "Casual leave (CL) and sick leave (SL)"],
  "/chat": ["Team Chat", "Channels for the team, direct messages for one-to-one"],
  "/analytics/": ["Format analytics", "Total performance across all posts of one format"],
  "/analytics": ["Analytics", "Content performance across your channels and platforms"],
  "/ads-performance": ["Ads performance", "Every ad, its results, and how each editor and team is doing"],
  "/ad-uploads": ["Ad uploads", "Approved ads by team: record the ad numbers each one became"],
  "/scheduling": ["Scheduling", "Approved reels, carousels and posts: set the post date, then paste each link"],
  "/metrics": ["Social & Ads Pipeline", "Every reel, carousel and ad in production. Stages are read-only here — move work on the Task Board."],
  "/insights": ["Insights", "What your data is telling you — computed automatically"],
  "/trends": ["Trends", "How your content is performing over time, and platform vs platform"],
  "/leaderboard": ["Editor Leaderboard", "Editor performance & rankings from published posts"],
  "/reports": ["Reports", "Export and share performance summaries"],
  "/posts/new": ["Add Post", "Create the post record now — log its metrics after you publish"],
  "/posts": ["Posts", "Your content database — replaces the Manual Entry sheet"],
  "/goals-board": ["Goals", "This month's goals by content type, and how far along they are"],
  "/channels": ["Channels & Platforms", "Manage channels, platforms, and Instagram sync — all in one place"],
  "/tasks": ["Task Management", "Assign and track your team's daily tasks"],
  "/my-team": ["My Team", "Who is working right now, everyone ranked for the dates you pick, and the roster"],
  "/social-media": ["Social Media", "Work generated by your posts, tracked per account — claim it or see who's on it"],
  "/task-rules": ["Task Settings", "Content formats and how many hours each should take, per person or org-wide"],
  "/activity": ["Activity", "Updates on your tasks and the team, newest first"],
  "/settings": ["Settings", "How Echo works for your team — calendar, channels, content, tasks, scoring and access"],
};
