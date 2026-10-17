import type { ReactNode } from "react";

// Line icons for the sidebar, as in the Pulse Redesign: drawn by stroke so
// they take the item's colour. Keyed by route, so lib/nav.ts stays as it is;
// anything without one here keeps its emoji.
const svg = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const NAV_ICONS: Record<string, ReactNode> = {
  "/home": svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h5v-6h4v6h5V9.5" /></>),
  "/chat": svg(<><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></>),
  "/tasks": svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16M15 4v10" /></>),
  "/my-team": svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6a6.5 6.5 0 0 1 3.5 5.4" /></>),
  "/metrics": svg(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 9h18M8 5l-1.5 4M13 5l-1.5 4M18 5l-1.5 4" /></>),
  "/analytics": svg(<><path d="M3 3v18h18" /><path d="m7 15 4-5 3.5 3L20 6" /></>),
  "/leaderboard": svg(<><path d="M8 4h8v5a4 4 0 0 1-8 0Z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4" /></>),
  "/posts/new": svg(<><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M12 8v8M8 12h8" /></>),
  "/goals-board": svg(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".6" /></>),
  "/posts": svg(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>),
  "/settings": svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>),
};

export function navIcon(href: string): ReactNode | undefined {
  return NAV_ICONS[href];
}

export const SIGN_OUT_ICON = svg(<><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 16l-4-4 4-4M6 12h9" /></>);
export const RAIL_ICON = svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></>);
export const COMPOSE_ICON = svg(<><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></>);
export const SEARCH_ICON = svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const PLUS_ICON = svg(<path d="M12 5v14M5 12h14" />);
export const BREAK_ICON = svg(<><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3" /></>);
export const GEAR_ICON = NAV_ICONS["/settings"];
