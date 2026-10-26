// Ad uploads after approval (server/src/ad-uploads.js): approved Ad work waits
// in one list for the Managers and Team Leads, who record which ads it became —
// the AD number Animus gave it (the VSL team), or the ad's name or number
// another team sends back. One piece of work can run as several ads. Each ad
// then carries its results (lib/ad-results.ts: from Animus, or typed in).
import type { AdResults } from "@/lib/ad-results";

export type AdStage = "to_upload" | "uploaded";

// Where a task stands, or null when it isn't in the list (as the server says).
export function adStage(t: { status: string; upload_from?: string | null; ad_count?: number | null; ad_refs?: string[] }): AdStage | null {
  if (!t.upload_from || t.status !== "done") return null;
  return (t.ad_count ?? t.ad_refs?.length ?? 0) > 0 ? "uploaded" : "to_upload";
}

export const AD_STAGE_WORDS: Record<AdStage, string> = { to_upload: "To upload", uploaded: "Uploaded" };

// GET /tasks/:id/ads
export type TaskAds = {
  ready: boolean;
  inFlow?: boolean;
  stage?: AdStage | null;
  ads?: { id: string; ref: string; source: "manual" | "animus"; createdAt: string; byName: string | null;
    // its results and its 14-day window (once the database has them)
    results?: AdResults; window?: string | null }[];
  canRecord?: boolean;
};

// "AD205, AD206" or one per line → ["AD205", "AD206"]; another team's ad names
// may hold spaces, so only commas and new lines split.
export const splitAdRefs = (text: string) => text.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
