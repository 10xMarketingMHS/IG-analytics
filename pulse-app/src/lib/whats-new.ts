// Settings › About Echo: what's new, release by release, newest first. Add a
// release here whenever the version in server/package.json (and
// pulse-app/package.json) goes up — a few plain lines, the way the team would say it.
export type Release = { version: string; date: string; notes: string[] };

export const RELEASES: Release[] = [
  {
    version: "1.0",
    date: "2026-10-26",
    notes: [
      "Knowledge Hub: SOPs, brand guidelines and training in one place",
      "Page access: what each position can see and change, page by page",
      "Social and Ads in the sidebar, each with its pages as tabs",
      "Ads performance: every ad's results, by editor and by team",
      "Scheduling: post dates, links due in two days, and credit for scheduling",
      "Analytics keeps a post's numbers when Instagram or Facebook doesn't answer, and now saves them day by day",
    ],
  },
];
