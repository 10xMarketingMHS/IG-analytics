// Ads performance (server/src/ad-results.js): each recorded ad's results — VSL's
// sent by Animus after every spend sync, the other teams' typed in by the
// Managers and Team Leads, as in their "Ads Tracker" sheet. Shown only.

export type AdResults = {
  publishedOn: string | null; adStatus: "Active" | "Inactive" | string | null;
  hookRate: number | null; holdRate: number | null; leads: number | null; conversions: number | null;
  roas: number | null; spend: number | null; revenue: number | null; impressions?: number | null;
  optIns?: number | null; score: number | null; notes?: string | null;
  source?: "animus" | "manual" | null; at?: string | null;
};

// 0.17 → "17%"; 6.8912 → "6.89×"; 35332 → "₹35,332"; null → "—"
export const pctWords = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);
export const roasWords = (v: number | null | undefined) => (v == null ? "—" : `${(Math.round(v * 100) / 100).toFixed(2)}×`);
export const rupees = (v: number | null | undefined) => (v == null ? "—" : `₹${Math.round(v).toLocaleString("en-IN")}`);
export const countWords = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
export const scoreWords = (v: number | null | undefined) => (v == null ? "—" : String(Math.round(v * 10) / 10));
export const dayShort = (ymd: string | null | undefined) => (ymd ? new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
// the 14-day window's tone: "Overdue" late, under 4 days soon
export const windowTone = (w: string | null | undefined) => (!w ? "" : w === "Overdue" ? "late" : w === "Set publish date" ? "soon" : parseInt(w, 10) <= 3 ? "soon" : "");

// What the typed-results form sends (PATCH /tasks/:id/ads/:adId/results): rates as fractions
export type ResultsPatch = Partial<{
  publishedOn: string | null; adStatus: "Active" | "Inactive" | null; hookRate: number | null; holdRate: number | null;
  leads: number | null; conversions: number | null; roas: number | null; notes: string | null;
}>;
