// Social and Ads: the sidebar's two places for the work after the Task Board,
// each a row of tabs in the order the work moves (components/section-tabs.tsx).
//   Social — Pipeline (Social work) → Scheduling → Posts
//   Ads    — Pipeline (Ads work)    → Uploads    → Performance
// The pages keep their own addresses, so old links still open the right tab;
// the Pipeline is one page, told which work to show by ?type=.

export type SectionKey = "social" | "ads";
export type SectionTab = {
  key: string; label: string; to: string; desc: string;
  // who sees the tab: everyone, this month's schedulers and the leads, or the Managers and TLs
  access?: "scheduler" | "uploads";
};

export const SECTIONS: Record<SectionKey, { title: string; tabs: SectionTab[] }> = {
  social: {
    title: "Social",
    tabs: [
      { key: "pipeline", label: "Pipeline", to: "/metrics?type=social", desc: "Every reel, carousel and post in production. Stages are read-only here — move work on the Task Board." },
      { key: "scheduling", label: "Scheduling", to: "/scheduling", access: "scheduler", desc: "Approved reels, carousels and posts: set the post date, then paste each link" },
      { key: "posts", label: "Posts", to: "/posts", desc: "Your content database — replaces the Manual Entry sheet" },
    ],
  },
  ads: {
    title: "Ads",
    tabs: [
      { key: "pipeline", label: "Pipeline", to: "/metrics?type=ad", desc: "Every ad in production, team by team. Stages are read-only here — move work on the Task Board." },
      { key: "uploads", label: "Uploads", to: "/ad-uploads", access: "uploads", desc: "Approved ads by team: record the ad numbers each one became" },
      { key: "performance", label: "Performance", to: "/ads-performance", desc: "Every ad, its results, and how each editor and team is doing" },
    ],
  },
};

// Which section and tab a page is, or null for a page outside them.
export function sectionOf(pathname: string, search: string): { section: SectionKey; tab: SectionTab } | null {
  const tab = (s: SectionKey, key: string) => ({ section: s, tab: SECTIONS[s].tabs.find((t) => t.key === key)! });
  if (pathname === "/metrics") return new URLSearchParams(search).get("type") === "ad" ? tab("ads", "pipeline") : tab("social", "pipeline");
  if (pathname === "/scheduling") return tab("social", "scheduling");
  if (pathname === "/posts") return tab("social", "posts");
  if (pathname === "/ad-uploads") return tab("ads", "uploads");
  if (pathname === "/ads-performance") return tab("ads", "performance");
  return null;
}
