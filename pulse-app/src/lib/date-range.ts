export type RangeKey =
  | "today" | "yesterday" | "last7" | "last14" | "last28" | "last30"
  | "thisweek" | "lastweek" | "thismonth" | "lastmonth" | "thisyear" | "all" | "custom";

export const RANGE_PRESETS: [RangeKey, string][] = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["last7", "Last 7 days"],
  ["last14", "Last 14 days"], ["last28", "Last 28 days"], ["last30", "Last 30 days"],
  ["thisweek", "This week"], ["lastweek", "Last week"], ["thismonth", "This month"],
  ["lastmonth", "Last month"], ["thisyear", "This year"], ["all", "All time"],
];

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function startOfWeek(d: Date) {
  // Monday-based (PRD §10.4 weekly rollup is Mon–Sun)
  const c = new Date(d);
  const day = (c.getDay() + 6) % 7;
  return addDays(c, -day);
}

// Returns { from, to } inclusive ISO date strings, or null bound for open-ended.
export function rangeFor(key: RangeKey): { from: string | null; to: string | null } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (key) {
    case "today": return { from: iso(today), to: iso(today) };
    case "yesterday": { const y = addDays(today, -1); return { from: iso(y), to: iso(y) }; }
    case "last7": return { from: iso(addDays(today, -6)), to: iso(today) };
    case "last14": return { from: iso(addDays(today, -13)), to: iso(today) };
    case "last28": return { from: iso(addDays(today, -27)), to: iso(today) };
    case "last30": return { from: iso(addDays(today, -29)), to: iso(today) };
    case "thisweek": return { from: iso(startOfWeek(today)), to: iso(today) };
    case "lastweek": {
      const s = addDays(startOfWeek(today), -7);
      return { from: iso(s), to: iso(addDays(s, 6)) };
    }
    case "thismonth": return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
    case "lastmonth": {
      const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const e = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: iso(s), to: iso(e) };
    }
    case "thisyear": return { from: iso(new Date(today.getFullYear(), 0, 1)), to: iso(today) };
    case "all":
    default: return { from: null, to: null };
  }
}

// Preceding equal-length window (PRD §10.4) for growth %.
export function previousRange(from: string, to: string): { from: string; to: string } {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const prevTo = addDays(f, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from: iso(prevFrom), to: iso(prevTo) };
}

export function inRange(date: string, from: string | null, to: string | null): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function labelFor(key: RangeKey): string {
  return RANGE_PRESETS.find((p) => p[0] === key)?.[1] ?? "Custom";
}

export function compactNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "K";
  return String(n);
}
