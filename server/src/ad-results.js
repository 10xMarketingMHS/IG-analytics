import { hasColumn } from "./schema-flags.js";

// Ads performance (20261107120000_ad_results): each recorded ad's results —
// VSL's sent by Animus after every spend sync, the other teams' typed in by the
// Managers and Team Leads, as in their "Ads Tracker" sheet — and how they add
// up per task, per editor and per team, the way that sheet's formulas did.
// Shown only: nothing here counts toward goals, points or the Leaderboard.

export const resultsReady = () => hasColumn("task_ad", "hook_rate");
export const NEEDS_RESULTS_DB = "Ads performance needs a database update first — ask whoever runs the database to apply 20261107120000_ad_results.";

// the result columns, as the API names them
export const RESULT_COLUMNS = {
  publishedOn: "published_on", adStatus: "ad_status", hookRate: "hook_rate", holdRate: "hold_rate", leads: "leads",
  conversions: "conversions", roas: "roas", spend: "spend", revenue: "revenue", impressions: "impressions",
  optIns: "opt_ins", score: "score", notes: "notes",
};
// an ad's results from a task_ad row, numbers as numbers
export function resultsOf(row) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    publishedOn: row.published_on ? String(row.published_on).slice(0, 10) : null, adStatus: row.ad_status ?? null,
    hookRate: num(row.hook_rate), holdRate: num(row.hold_rate), leads: num(row.leads), conversions: num(row.conversions),
    roas: num(row.roas), spend: num(row.spend), revenue: num(row.revenue), impressions: num(row.impressions),
    optIns: num(row.opt_ins), score: num(row.score), notes: row.notes ?? null,
    source: row.results_source ?? null, at: row.results_at ?? null,
  };
}

const present = (list, k) => list.filter((x) => x[k] != null);
const sumOf = (list, k) => { const h = present(list, k); return h.length ? h.reduce((s, x) => s + Number(x[k]), 0) : null; };
const avgOf = (list, k) => { const h = present(list, k); return h.length ? sumOf(h, k) / h.length : null; };
// score: weighted by spend where there is spend (as Animus does), else a plain average
const scoreOf = (list) => {
  const scored = present(list, "score");
  if (!scored.length) return null;
  const spent = scored.filter((x) => Number(x.spend) > 0);
  return spent.length ? spent.reduce((s, x) => s + x.score * x.spend, 0) / spent.reduce((s, x) => s + Number(x.spend), 0) : avgOf(scored, "score");
};

// One task's results across its ads (a video can run as several): leads,
// conversions, spend summed; hook and hold averaged; ROAS from revenue over
// spend where Animus gave both, else the average of the typed ROAS; Active if
// any ad is; published on the earliest.
export function combine(ads) {
  const withResults = ads.filter((a) => a.source || a.publishedOn || a.adStatus);
  if (!withResults.length) return null;
  const spend = sumOf(ads, "spend"), revenue = sumOf(ads, "revenue");
  const dates = ads.map((a) => a.publishedOn).filter(Boolean).sort();
  return {
    publishedOn: dates[0] ?? null,
    adStatus: ads.some((a) => a.adStatus === "Active") ? "Active" : ads.find((a) => a.adStatus)?.adStatus ?? null,
    hookRate: avgOf(ads, "hookRate"), holdRate: avgOf(ads, "holdRate"),
    leads: sumOf(ads, "leads"), conversions: sumOf(ads, "conversions"),
    roas: spend > 0 && revenue != null ? revenue / spend : avgOf(ads, "roas"),
    spend, revenue, score: scoreOf(ads),
  };
}

// The 14-day results window after an ad goes live, as the sheet's "Due Week
// Data" counted it: "9 days left", "1 day left", "Overdue" — or, published with
// no date yet, "Set publish date".
export const WINDOW_DAYS = 14;
export function windowWords(publishedOn, today) {
  if (!publishedOn) return "Set publish date";
  const left = WINDOW_DAYS - Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${publishedOn}T00:00:00Z`)) / 86_400_000);
  return left <= 0 ? "Overdue" : left === 1 ? "1 day left" : `${left} days left`;
}

// Editors or teams, the way the sheet's Editor Performance tab added them up:
// how many ads; averages of hook, hold and ROAS over the ads that have them;
// leads and conversions summed, and conversions per lead; how many are done,
// pending and published; and, from Animus, spend and score.
export function summarize(tasks, keyOf, nameOf) {
  const groups = new Map();
  for (const t of tasks) {
    const k = keyOf(t);
    if (!groups.has(k)) groups.set(k, { key: k, name: nameOf(t), tasks: [] });
    groups.get(k).tasks.push(t);
  }
  return [...groups.values()].map((g) => {
    const r = g.tasks.map((t) => ({ ...(t.results ?? {}) }));
    const leads = sumOf(r, "leads"), conversions = sumOf(r, "conversions");
    return {
      key: g.key, name: g.name, ads: g.tasks.length,
      avgHook: avgOf(r, "hookRate"), avgHold: avgOf(r, "holdRate"),
      leads, conversions, leadToConv: leads ? (conversions ?? 0) / leads : null,
      avgRoas: avgOf(r, "roas"), spend: sumOf(r, "spend"), avgScore: scoreOf(r),
      done: g.tasks.filter((t) => t.stage === "done").length,
      pending: g.tasks.filter((t) => t.stage === "pending").length,
      published: g.tasks.filter((t) => t.stage === "published").length,
    };
  }).sort((a, b) => b.ads - a.ads || String(a.name).localeCompare(String(b.name)));
}
