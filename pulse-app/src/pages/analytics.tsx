import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useEditors } from "@/lib/use-editors";
import { gradFor } from "@/lib/editor-visuals";
import {
  RANGE_PRESETS, rangeFor, previousRange, inRange, labelFor, compactNum, type RangeKey,
} from "@/lib/date-range";
import { performanceScore } from "@/lib/score";
import type { Post, Platform, Account } from "@/lib/types";
import { csvCell } from "@/lib/csv";
import "./analytics.css";

// Analytics — the Dashboard and Top Performers in one page (Pulse Redesign v5).
// Overview: KPIs, the trend over the range, where the views come from, and the
// best three posts. Top performers: every published post ranked by the metric
// you pick. Both read the same filters — channel, platform and date range — and
// count Published posts only; collab mirrors never count toward performance.

type P = Post & { channel_id?: string; channel_name?: string };
type FollowerRow = {
  connectionId: string; provider: string; externalId: string; platformKey: string; channelId: string;
  current: number | null; atFrom: number | null; atTo: number | null;
};
type FollowerDaily = {
  connectionId: string; provider: string; externalId: string; platformKey: string; channelId: string;
  day: string; followerCount: number;
};

// Categorical colours, in a fixed order that passes the colourblind checks in
// light and dark (see analytics.css). Assigned by position, never cycled.
const SERIES = ["var(--an-s1)", "var(--an-s2)", "var(--an-s3)", "var(--an-s4)"];
const OTHER = "var(--an-other)";
export const PLATFORM_COLOR: Record<string, string> = { instagram: "#e1306c", facebook: "#1877f2", youtube: "#ff0033" };
export const PLATFORM_AB: Record<string, string> = { instagram: "IG", facebook: "FB", youtube: "YT" };
const TYPE_LABEL: Record<string, string> = { reel: "Reel", carousel: "Carousel" };

const svg = (paths: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
);
// Icons, shared with the Posts page (posts.tsx), which uses this design too.
export const IC = {
  eye: svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, 15),
  users: svg(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>, 15),
  heart: svg(<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />, 15),
  upload: svg(<><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></>, 15),
  calendar: svg(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>, 15),
  chev: svg(<path d="m6 9 6 6 6-6" />, 15),
  trend: svg(<><path d="m22 7-8.5 8.5-5-5L2 17" /><path d="M16 7h6v6" /></>, 17),
  bars: svg(<path d="M6 20v-8M12 20V6M18 20v-4" />, 17),
  rocket: svg(<><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /></>, 17),
  bulb: svg(<><path d="M9 18h6M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" /></>, 17),
  play: svg(<path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />, 22),
  carousel: svg(<><rect x="6" y="4" width="12" height="16" rx="2" /><path d="M2 7v10M22 7v10" /></>, 20),
  grid: svg(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>, 15),
  arrow: svg(<path d="M5 12h14M13 6l6 6-6 6" />, 15),
  bookmark: svg(<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />, 15),
  send: svg(<><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>, 15),
  award: svg(<><circle cx="12" cy="8" r="6" /><path d="M15.5 13 17 22l-5-3-5 3 1.5-9" /></>, 16),
  layout: svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>, 16),
  download: svg(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, 15),
  table: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></>, 14),
  chart: svg(<><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></>, 14),
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, 15),
  x: svg(<path d="M18 6 6 18M6 6l12 12" />, 14),
  columns: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>, 15),
  trash: svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>, 15),
  ext: svg(<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>, 13),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, 15),
};

// ── numbers & dates ─────────────────────────────────────────────────────────
const engOf = (p: Post) => p.likes + p.comments + p.shares + p.saves;
const sumBy = <T,>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);
const rateOf = (eng: number, reach: number) => (reach > 0 ? (eng / reach) * 100 : 0);
const pct = (n: number) => n.toFixed(1) + "%";
const dayOf = (iso: string) => new Date(iso + "T00:00:00");
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso: string, n: number) => { const d = dayOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const spanDays = (from: string, to: string) => Math.round((dayOf(to).getTime() - dayOf(from).getTime()) / 86400000) + 1;
export const shortDate = (iso: string) => dayOf(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const growthPct = (cur: number, prev: number) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

// The trend is drawn in days for short ranges, weeks up to ~7 months, months
// beyond that — so a chart always has a readable number of points.
type Unit = "day" | "week" | "month";
type Bucket = { from: string; to: string };
const unitFor = (days: number): Unit => (days <= 14 ? "day" : days <= 210 ? "week" : "month");
function bucketsOf(from: string, to: string, unit: Unit): Bucket[] {
  const out: Bucket[] = [];
  if (unit === "month") {
    for (let cur = from; cur <= to && out.length < 240;) {
      const d = dayOf(cur);
      const end = isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      out.push({ from: cur, to: end < to ? end : to });
      cur = isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    }
    return out;
  }
  const step = unit === "day" ? 1 : 7;
  for (let cur = from; cur <= to && out.length < 400; cur = addDays(cur, step)) {
    const end = addDays(cur, step - 1);
    out.push({ from: cur, to: end < to ? end : to });
  }
  return out;
}
const bucketAt = (list: Bucket[], iso: string) => list.findIndex((b) => iso >= b.from && iso <= b.to);
const bucketLabel = (b: Bucket, unit: Unit) =>
  unit === "month" ? dayOf(b.from).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : shortDate(b.from);

type Agg = { views: number; reach: number; eng: number; posts: number };
function aggregate(list: Bucket[], perf: P[], counted: P[]): Agg[] {
  const out = list.map(() => ({ views: 0, reach: 0, eng: 0, posts: 0 }));
  for (const p of perf) {
    const i = bucketAt(list, p.date);
    if (i >= 0) { out[i].views += p.views; out[i].reach += p.reach; out[i].eng += engOf(p); }
  }
  for (const p of counted) { const i = bucketAt(list, p.date); if (i >= 0) out[i].posts += 1; }
  return out;
}

// A smooth line through the points that never overshoots them (each segment's
// control points share the y of its ends).
function curve(pts: [number, number][]) {
  if (!pts.length) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], xm = ((x0 + x1) / 2).toFixed(1);
    d += ` C${xm},${y0.toFixed(1)} ${xm},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}
function sparkPath(vals: number[], w = 100, h = 34) {
  const max = Math.max(...vals, 0);
  const n = vals.length;
  const pts: [number, number][] = (n === 1 ? [vals[0], vals[0]] : vals).map((v, i, a) =>
    [(i / (a.length - 1)) * w, h - 3 - (max ? v / max : 0) * (h - 6)]);
  return curve(pts);
}
function niceMax(v: number) {
  if (v <= 0) return 4;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 4 ? 4 : f <= 5 ? 5 : 10) * e;
}

// Follower totals day by day for the accounts in scope: each account's latest
// count carried forward, summed, counting each real account once (the same Page
// can be connected to two channels).
function followerSeries(rows: FollowerDaily[]) {
  const byAcct = new Map<string, Map<string, number>>();
  const days = new Set<string>();
  for (const r of rows) {
    if (!byAcct.has(r.externalId)) byAcct.set(r.externalId, new Map());
    byAcct.get(r.externalId)!.set(r.day, r.followerCount);
    days.add(r.day);
  }
  const sorted = [...days].sort();
  const out: { day: string; total: number }[] = [];
  for (const day of sorted) {
    let sum = 0, any = false;
    for (const m of byAcct.values()) {
      let best: number | null = null, bestDay = "";
      for (const [d, v] of m) if (d <= day && d > bestDay) { best = v; bestDay = d; }
      if (best != null) { sum += best; any = true; }
    }
    if (any) out.push({ day, total: sum });
  }
  return out;
}

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "top" ? "top" : "over";
  const tabsRef = useRef<HTMLDivElement>(null);
  const setTab = (t: "over" | "top") => setParams(t === "top" ? { tab: "top" } : {}, { replace: true });
  // From the bottom of Overview, land on the new tab rather than its footer.
  const openTop = () => {
    setTab("top");
    const el = tabsRef.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const { workspaces } = useWorkspaces();
  const { taxonomy } = useTaxonomy();
  const { editors } = useEditors();
  const navigate = useNavigate();
  const location = useLocation();

  const [channel, setChannel] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [range, setRange] = useState<RangeKey>("last90");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [compare, setCompare] = useState(true);

  const { data: postData, loading } = useResource<{ posts: P[] }>(`/posts?channel=${channel}`);
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { data: acctData } = useResource<{ accounts: Account[] }>(`/accounts?channel=${channel}`);
  const { data: folData } = useResource<{ followers: FollowerRow[] }>("/integrations/followers");
  const { data: dailyData } = useResource<{ series: FollowerDaily[] }>("/integrations/followers/daily?days=30");

  const allPosts = postData?.posts ?? null;
  // Platforms worth a chip: connected to this channel scope, or carrying posts.
  const platforms = useMemo(() => {
    const ids = new Set<string>((acctData?.accounts ?? []).map((a) => a.platform_id));
    for (const p of allPosts ?? []) if (p.platform_id) ids.add(p.platform_id);
    return (platData?.platforms ?? []).filter((p) => ids.has(p.id)).sort((a, b) => a.sort_order - b.sort_order);
  }, [acctData, allPosts, platData]);
  useEffect(() => {
    if (platform !== "all" && platforms.length && !platforms.some((p) => p.id === platform)) setPlatform("all");
  }, [platforms, platform]);
  const activePlatform = platforms.find((p) => p.id === platform) ?? null;

  const published = useMemo(
    () => (allPosts ?? []).filter((p) => p.status === "published" && (platform === "all" || p.platform_id === platform)),
    [allPosts, platform],
  );

  // The range in real dates: "All time" runs from the first published post.
  const today = isoOf(new Date());
  const bounds = range === "custom" && custom ? custom : rangeFor(range);
  const from = bounds.from ?? (published.length ? published.reduce((m, p) => (p.date < m ? p.date : m), today) : today);
  const to = bounds.to ?? (published.length ? published.reduce((m, p) => (p.date > m ? p.date : m), today) : today);
  const prev = range === "all" ? null : previousRange(from, to);
  const canCompare = !!prev;

  const noMirror = (list: P[]) => list.filter((p) => !p.is_collab_mirror);
  const scoped = useMemo(() => published.filter((p) => inRange(p.date, from, to)), [published, from, to]);
  const perf = useMemo(() => noMirror(scoped), [scoped]);
  // On "All channels" a collab post is one post; on one channel its copy counts.
  const counted = useMemo(() => (channel === "all" ? noMirror(scoped) : scoped), [scoped, channel]);
  const prevScoped = useMemo(() => (prev ? published.filter((p) => inRange(p.date, prev.from, prev.to)) : []), [published, prev?.from, prev?.to]);
  const prevPerf = useMemo(() => noMirror(prevScoped), [prevScoped]);
  const prevCounted = useMemo(() => (channel === "all" ? noMirror(prevScoped) : prevScoped), [prevScoped, channel]);

  const unit = unitFor(spanDays(from, to));
  const buckets = useMemo(() => bucketsOf(from, to, unit), [from, to, unit]);
  const prevBuckets = useMemo(() => (prev ? bucketsOf(prev.from, prev.to, unit) : []), [prev?.from, prev?.to, unit]);
  const series = useMemo(() => aggregate(buckets, perf, counted), [buckets, perf, counted]);
  const prevSeries = useMemo(() => aggregate(prevBuckets, prevPerf, prevCounted), [prevBuckets, prevPerf, prevCounted]);

  const views = sumBy(perf, (p) => p.views), reach = sumBy(perf, (p) => p.reach), eng = sumBy(perf, engOf);
  const pViews = sumBy(prevPerf, (p) => p.views), pReach = sumBy(prevPerf, (p) => p.reach), pEng = sumBy(prevPerf, engOf);
  const er = rateOf(eng, reach), pEr = rateOf(pEng, pReach);

  // Facebook stopped reporting views; when a scope has none, chart engagements.
  const chartOnEng = views === 0 && eng > 0;
  const chartVal = (a: Agg) => (chartOnEng ? a.eng : a.views);
  const chartTitle = chartOnEng
    ? `${activePlatform ? activePlatform.name + " engagements" : "Engagements across platforms"}`
    : `${activePlatform ? activePlatform.name + " views" : "Views across platforms"}`;

  const kpis = [
    { l: "Total views", icon: IC.eye, c: "var(--an-k1)", v: compactNum(views), d: prev ? growthPct(views, pViews) : null, unit: "%", line: series.map((a) => a.views) },
    { l: "Reach", icon: IC.users, c: "var(--an-k2)", v: compactNum(reach), d: prev ? growthPct(reach, pReach) : null, unit: "%", line: series.map((a) => a.reach) },
    { l: "Engagement rate", icon: IC.heart, c: "var(--an-k3)", v: reach ? pct(er) : "—", d: prev && pReach > 0 && reach > 0 ? er - pEr : null, unit: " pt", line: series.map((a) => rateOf(a.eng, a.reach)) },
    { l: "Posts published", icon: IC.upload, c: "var(--an-k4)", v: String(counted.length), d: prev ? growthPct(counted.length, prevCounted.length) : null, unit: "%", line: series.map((a) => a.posts) },
  ];

  // Views by channel, each channel keeping its colour by its place in the list.
  const byChannel = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of perf) if (p.channel_id) m.set(p.channel_id, (m.get(p.channel_id) ?? 0) + (chartOnEng ? engOf(p) : p.views));
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return workspaces
      .map((w, i) => ({ id: w.id, name: w.name, v: m.get(w.id) ?? 0, c: i < SERIES.length ? SERIES[i] : OTHER }))
      .filter((r) => r.v > 0)
      .map((r) => ({ ...r, share: total ? (r.v / total) * 100 : 0 }));
  }, [perf, workspaces, chartOnEng]);

  // Format mix: share of posts by format (F#); past four, the rest fold into Other.
  const formatMix = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of counted) m.set(p.format_id, (m.get(p.format_id) ?? 0) + 1);
    const rows = [...m.entries()]
      .map(([id, n]) => ({ id, name: taxonomy?.formats.find((f) => f.id === id)?.name ?? "No format", n }))
      .sort((a, b) => b.n - a.n);
    const total = counted.length;
    const shown = rows.length > 4 ? rows.slice(0, 3) : rows;
    const rest = rows.length > 4 ? rows.slice(3).reduce((s, r) => s + r.n, 0) : 0;
    const out = shown.map((r, i) => ({ name: r.name, n: r.n, c: SERIES[i], share: total ? (r.n / total) * 100 : 0 }));
    if (rest) out.push({ name: "Other", n: rest, c: OTHER, share: (rest / total) * 100 });
    return out;
  }, [counted, taxonomy]);

  const byGroup = (getId: (p: P) => string, list?: { id: string; name: string }[]) => {
    const m = new Map<string, { v: number; n: number }>();
    for (const p of perf) { const k = getId(p); const cur = m.get(k) ?? { v: 0, n: 0 }; cur.v += p.views; cur.n += 1; m.set(k, cur); }
    return (list ?? [])
      .map((x) => ({ name: x.name, ...(m.get(x.id) ?? { v: 0, n: 0 }) }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 6);
  };
  const byPillar = byGroup((p) => p.pillar_id, taxonomy?.pillars);
  const byAvatar = byGroup((p) => p.avatar_id, taxonomy?.avatars);

  const typeSplit = (["reel", "carousel"] as const).map((t, i) => {
    const ps = perf.filter((p) => p.post_type === t);
    const v = sumBy(ps, (p) => p.views);
    return { t, l: t === "reel" ? "Reels" : "Carousels", c: SERIES[i], icon: t === "reel" ? IC.play : IC.carousel,
      v, n: counted.filter((p) => p.post_type === t).length, er: rateOf(sumBy(ps, engOf), sumBy(ps, (p) => p.reach)), avg: ps.length ? v / ps.length : 0 };
  });

  const insight = useMemo(() => {
    const overall = rateOf(sumBy(perf, engOf), sumBy(perf, (p) => p.reach));
    const fm = new Map<string, P[]>();
    for (const p of perf) fm.set(p.format_id, [...(fm.get(p.format_id) ?? []), p]);
    let best: { name: string; er: number } | null = null;
    for (const [id, ps] of fm) {
      if (ps.length < 2) continue;
      const r = rateOf(sumBy(ps, engOf), sumBy(ps, (p) => p.reach));
      if (!best || r > best.er) best = { name: taxonomy?.formats.find((f) => f.id === id)?.name ?? "Unformatted", er: r };
    }
    if (best && overall > 0 && best.er > overall * 1.1)
      return `${best.name} posts earn the best engagement rate here: ${pct(best.er)}, against ${pct(overall)} overall.`;
    const top = byPillar[0];
    const totalV = sumBy(perf, (p) => p.views);
    if (top && totalV && byPillar.length > 1) return `${top.name} brought ${Math.round((top.v / totalV) * 100)}% of the views in this range.`;
    return null;
  }, [perf, taxonomy, byPillar]);

  // Followers: today's total for the accounts in scope, and the last 30 days.
  const platformKey = activePlatform?.key ?? null;
  const inScope = (r: { platformKey: string; channelId: string }) =>
    (!platformKey || r.platformKey === platformKey) && (channel === "all" || r.channelId === channel);
  const followerNow = useMemo(() => {
    const seen = new Set<string>();
    let sum = 0, any = false;
    for (const f of folData?.followers ?? []) {
      if (!inScope(f) || f.current == null || seen.has(f.externalId)) continue;
      seen.add(f.externalId); sum += f.current; any = true;
    }
    return any ? sum : null;
  }, [folData, platformKey, channel]);
  const followerDays = useMemo(() => followerSeries((dailyData?.series ?? []).filter(inScope)), [dailyData, platformKey, channel]);

  const rangeName = range === "custom" ? "Custom range" : labelFor(range);
  const datesText = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  const openPost = (p: P) => navigate(`/posts/${p.id}/edit`, { state: { backgroundLocation: location } });
  const platformName = (id: string | null) => platData?.platforms.find((p) => p.id === id)?.name ?? "";

  function exportCsv() {
    const head = ["Date", "Title", "Channel", "Platform", "Type", "Views", "Reach", "Likes", "Comments", "Shares", "Saves", "Engagement rate %", "Performance score"];
    const rows = [...counted].sort((a, b) => (a.date < b.date ? 1 : -1)).map((p) => [
      p.date, p.title, p.channel_name ?? "", platformName(p.platform_id), TYPE_LABEL[p.post_type] ?? p.post_type,
      p.views, p.reach, p.likes, p.comments, p.shares, p.saves, rateOf(engOf(p), p.reach).toFixed(2), Math.round(performanceScore(p)),
    ]);
    const csv = [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `echo-analytics-${from}-to-${to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="screen an">
      <div className="an-bar">
        <select className="an-select" value={channel} onChange={(e) => setChannel(e.target.value)} title="Choose a channel">
          <option value="all">All channels</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <span className="an-scope">
          {activePlatform ? activePlatform.name : "All platforms"} · {counted.length} post{counted.length === 1 ? "" : "s"}
        </span>
        <span className="an-grow" />
        <RangePicker range={range} label={rangeName} dates={datesText} onPick={(k) => setRange(k)}
          onCustom={(f, t) => { setCustom({ from: f, to: t }); setRange("custom"); }} />
        <button type="button" className={"an-toggle" + (compare && canCompare ? " on" : "")} disabled={!canCompare}
          onClick={() => setCompare((c) => !c)} aria-pressed={compare && canCompare}
          title={canCompare ? "Show the previous period on the chart" : "All time has no earlier period to compare"}>
          <span className="an-switch"><span /></span>Compare
        </button>
        <button type="button" className="an-btn" onClick={exportCsv} disabled={!counted.length} title="Download these posts and their numbers as a CSV file">
          {IC.download}Export
        </button>
      </div>

      <div className="an-tabsrow" ref={tabsRef}>
        <div className="an-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "over"} className={tab === "over" ? "on" : ""} onClick={() => setTab("over")}>{IC.layout}Overview</button>
          <button type="button" role="tab" aria-selected={tab === "top"} className={tab === "top" ? "on" : ""} onClick={() => setTab("top")}>{IC.award}Top performers</button>
        </div>
        <span className="an-grow" />
        {platforms.length > 0 && (
          <div className="an-seg an-plats">
            <button type="button" className={platform === "all" ? "on" : ""} onClick={() => setPlatform("all")}>
              <span className="an-ptile all">All</span>All
            </button>
            {platforms.map((pf) => (
              <button key={pf.id} type="button" className={platform === pf.id ? "on" : ""} onClick={() => setPlatform(pf.id)}>
                <span className="an-ptile" style={{ background: PLATFORM_COLOR[pf.key] ?? "var(--an-ac)" }}>{PLATFORM_AB[pf.key] ?? pf.name.slice(0, 2).toUpperCase()}</span>{pf.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="an-card an-empty">Loading analytics…</div>
      ) : tab === "over" ? (
        <div className="an-stack">
          <div className="an-kpis">
            {kpis.map((k) => (
              <div className="an-kpi" key={k.l}>
                <div className="an-kpi-tx">
                  <span className="an-kpi-l"><span style={{ color: k.c }}>{k.icon}</span>{k.l}</span>
                  <span className="an-kpi-v"><b>{k.v}</b><Delta d={k.d} unit={k.unit} /></span>
                </div>
                {k.line.length > 1 && (
                  <svg className="an-spark" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label={`${k.l} by ${unit} across the range`}>
                    <path d={sparkPath(k.line)} fill="none" stroke={k.c} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            ))}
          </div>

          <div className="an-row">
            <TrendChart title={chartTitle} unit={unit} buckets={buckets} cur={series.map(chartVal)}
              prev={prevSeries.map(chartVal)} compare={compare && canCompare} metric={chartOnEng ? "engagements" : "views"} today={today} />

            <div className="an-side">
              <section className="an-card">
                <b className="an-h">By channel</b>
                {byChannel.length ? (
                  <div className="an-donutrow">
                    <Donut rows={byChannel} total={compactNum(sumBy(byChannel, (r) => r.v))} sub={chartOnEng ? "engagements" : "views"} />
                    <div className="an-chlist">
                      {byChannel.map((r) => (
                        <div key={r.id} className="an-ch">
                          <span className="an-chtile" style={{ background: r.c }}>{r.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
                          <span className="an-chtx"><b>{r.name}</b><span>{compactNum(r.v)} · {Math.round(r.share)}%</span></span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <p className="an-none">No views in this range yet.</p>}
              </section>
              <section className="an-card an-fill">
                <b className="an-h">Format mix</b>
                {formatMix.length ? (
                  <>
                    <div className="an-mixbar">
                      {formatMix.map((f) => <span key={f.name} style={{ width: `${Math.max(f.share, 2)}%`, background: f.c }} title={`${f.name}: ${f.n} post${f.n === 1 ? "" : "s"}`} />)}
                    </div>
                    {formatMix.map((f) => (
                      <div key={f.name} className="an-mixrow">
                        <span className="an-sw" style={{ background: f.c }} /><span className="an-mixname">{f.name}</span>
                        <span className="an-lead" /><b>{Math.round(f.share)}%</b>
                      </div>
                    ))}
                  </>
                ) : <p className="an-none">No posts in this range yet.</p>}
                {insight && (
                  <div className="an-insight">
                    <span className="an-insight-ic">{IC.bulb}</span>
                    <span><b>Insight</b><span>{insight}</span></span>
                  </div>
                )}
              </section>
            </div>
          </div>

          <div className="an-grid">
            <FollowerCard now={followerNow} days={followerDays} today={today} scope={activePlatform?.name ?? "All platforms"} />
            <section className="an-card">
              <div className="an-hd"><b className="an-h">Reels vs Carousels</b><span>Published in this range</span></div>
              <div className="an-split">
                {typeSplit.map((f) => (
                  <div key={f.t} className="an-splitbox">
                    <span className="an-splitl"><span className="an-splitic" style={{ background: f.c }}>{f.icon}</span>{f.l}</span>
                    <b>{compactNum(f.v)}</b>
                    <span className="an-splitst">
                      <span><b>{f.n}</b> posts</span><span><b>{f.v ? pct(f.er) : "—"}</b> eng.</span><span><b>{compactNum(Math.round(f.avg))}</b> avg</span>
                    </span>
                  </div>
                ))}
              </div>
              {typeSplit[0].v + typeSplit[1].v > 0 && (
                <>
                  <div className="an-mixbar thin">
                    {typeSplit.filter((f) => f.v > 0).map((f) => <span key={f.t} style={{ width: `${(f.v / (typeSplit[0].v + typeSplit[1].v)) * 100}%`, background: f.c }} title={`${f.l}: ${compactNum(f.v)} views`} />)}
                  </div>
                  <span className="an-note">{splitNote(typeSplit)}</span>
                </>
              )}
            </section>
            <Breakdown title="Views by pillar" sub="Which topics pull the audience" rows={byPillar} />
            <Breakdown title="Views by audience avatar" sub="Who the post speaks to" rows={byAvatar} />
          </div>

          <TopContent posts={perf} platformName={platformName} onOpen={openPost} scopeName={activePlatform?.name ?? "All platforms"}
            onAll={() => navigate("/posts")} />
          {perf.length > 3 && (
            <button type="button" className="an-more" onClick={openTop}>See all top performers{IC.arrow}</button>
          )}
        </div>
      ) : (
        <TopPerformers posts={perf} editors={editors ?? []} platformName={platformName} onOpen={openPost} />
      )}
    </section>
  );
}

function splitNote(split: { l: string; v: number; n: number; er: number }[]) {
  const [r, c] = split;
  const tot = r.v + c.v;
  if (!r.n || !c.n) return `Only ${r.n ? "reels" : "carousels"} were published in this range.`;
  return `Reels bring ${Math.round((r.v / tot) * 100)}% of views; carousels engage ${c.er >= r.er ? "better" : "less"} per person reached (${pct(c.er)} vs ${pct(r.er)}).`;
}

function Delta({ d, unit }: { d: number | null; unit: string }) {
  if (d == null || !isFinite(d)) return null;
  const up = d >= 0;
  return (
    <span className={"an-delta " + (up ? "up" : "down")} title="Against the previous period of the same length">
      {up ? "▲" : "▼"} {Math.abs(d).toFixed(1)}{unit}
    </span>
  );
}

export function RangePicker({ range, label, dates, onPick, onCustom }: {
  range: RangeKey; label: string; dates: string;
  onPick: (k: RangeKey) => void; onCustom: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(() => addDays(isoOf(new Date()), -29));
  const [t, setT] = useState(() => isoOf(new Date()));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="an-range" ref={ref}>
      <button type="button" className="an-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="an-muted">{IC.calendar}</span>{dates}<span className="an-rangelbl">{label}</span><span className="an-muted">{IC.chev}</span>
      </button>
      {open && (
        <div className="an-pop">
          <div className="an-presets">
            {RANGE_PRESETS.map(([k, l]) => (
              <button key={k} type="button" className={range === k ? "on" : ""} onClick={() => { onPick(k); setOpen(false); }}>{l}</button>
            ))}
          </div>
          <div className="an-custom">
            <b>Custom range</b>
            <label>From<input type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} /></label>
            <label>To<input type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} /></label>
            <button type="button" className="an-apply" disabled={!f || !t || f > t} onClick={() => { onCustom(f, t); setOpen(false); }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TrendChart({ title, unit, buckets, cur, prev, compare, metric, today }: {
  title: string; unit: Unit; buckets: Bucket[]; cur: number[]; prev: number[]; compare: boolean; metric: string; today: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const n = cur.length;
  const W = 720, H = 240;
  const max = niceMax(Math.max(1, ...cur, ...(compare ? prev : [])));
  const xAt = (i: number) => (n <= 1 ? W : (i / (n - 1)) * W);
  const yAt = (v: number) => H - (v / max) * (H - 10);
  const pts: [number, number][] = cur.map((v, i) => [xAt(i), yAt(v)]);
  const linePts: [number, number][] = n === 1 ? [[0, pts[0][1]], pts[0]] : pts;
  const line = curve(linePts);
  const area = line ? `${line} L${W},${H} L0,${H} Z` : "";
  const prevPts: [number, number][] = prev.slice(0, n).map((v, i) => [xAt(i), yAt(v)]);
  const prevLine = compare ? curve(n === 1 && prevPts.length ? [[0, prevPts[0][1]], prevPts[0]] : prevPts) : "";
  const ticks = [1, 0.75, 0.5, 0.25].map((f) => ({ top: `${(yAt(max * f) / H) * 100}%`, l: compactNum(Math.round(max * f)) }));
  const unitWord = unit === "day" ? "Daily" : unit === "week" ? "Weekly" : "Monthly";
  const labels = buckets.map((b) => bucketLabel(b, unit));
  const xIdx = n <= 6 ? buckets.map((_, i) => i) : [0, 1, 2, 3, 4, 5].map((k) => Math.round((k * (n - 1)) / 5));
  const last = n - 1;
  const lastHasToday = n > 0 && buckets[last].from <= today && today <= buckets[last].to;
  const lastLabel = n > 0
    ? `${compactNum(cur[last])} ${lastHasToday ? (unit === "day" ? "today" : `this ${unit}`) : `· ${labels[last]}`}`
    : "";
  const peak = n ? cur.reduce((bi, v, i) => (v > cur[bi] ? i : bi), 0) : 0;
  const avg = n ? cur.reduce((a, b) => a + b, 0) / n : 0;
  const growth = n > 1 && cur[0] > 0 ? ((cur[last] - cur[0]) / cur[0]) * 100 : null;
  const tip = hover == null ? null : {
    i: hover, x: n <= 1 ? 100 : (hover / (n - 1)) * 100, y: (pts[hover][1] / H) * 100,
    cur: cur[hover], prev: prev[hover] ?? null,
  };
  const tipDelta = tip && tip.prev != null && tip.prev > 0 ? ((tip.cur - tip.prev) / tip.prev) * 100 : null;
  const tipHead = tip ? (unit === "week" ? `Week of ${labels[tip.i]}` : labels[tip.i]) : "";

  return (
    <section className="an-card an-chart">
      <div className="an-charthead">
        <div className="an-hd"><b className="an-h">{title}</b><span>{unitWord} · hover the chart for detail</span></div>
        <span className="an-grow" />
        <span className="an-key cur"><span />This period</span>
        {compare && <span className="an-key prev"><span />Previous</span>}
        <button type="button" className="an-iconbtn" onClick={() => setAsTable((v) => !v)} title={asTable ? "Show the chart" : "Show the numbers as a table"} aria-label={asTable ? "Show the chart" : "Show the numbers as a table"}>
          {asTable ? IC.chart : IC.table}
        </button>
      </div>
      {asTable ? (
        <div className="an-tablewrap">
          <table className="an-table">
            <thead><tr><th>{unit === "week" ? "Week of" : unit === "day" ? "Day" : "Month"}</th><th>This period</th>{compare && <th>Previous</th>}</tr></thead>
            <tbody>
              {buckets.map((b, i) => (
                <tr key={b.from}><td>{labels[i]}</td><td>{cur[i].toLocaleString()}</td>{compare && <td>{prev[i] != null ? prev[i].toLocaleString() : "—"}</td>}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="an-plotwrap">
            <div className="an-yaxis">
              {ticks.map((t) => <span key={t.l + t.top} style={{ top: t.top }}>{t.l}</span>)}
              <span style={{ top: "100%" }}>0</span>
            </div>
            <div className="an-plot" onMouseMove={(e) => {
              if (n < 1) return;
              const r = e.currentTarget.getBoundingClientRect();
              const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
              setHover(n === 1 ? 0 : Math.round(f * (n - 1)));
            }} onMouseLeave={() => setHover(null)}>
              {ticks.map((t) => <span key={t.top} className="an-gridline" style={{ top: t.top }} />)}
              <span className="an-gridline base" />
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="an-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--an-ac)" stopOpacity=".34" /><stop offset=".7" stopColor="var(--an-ac)" stopOpacity=".06" /><stop offset="1" stopColor="var(--an-ac)" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="an-line" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="var(--an-ac2)" /><stop offset="1" stopColor="var(--an-ac)" />
                  </linearGradient>
                </defs>
                <path d={area} fill="url(#an-fill)" />
                {prevLine && <path d={prevLine} fill="none" stroke="var(--an-text3)" strokeWidth="1.6" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" opacity=".75" />}
                <path d={line} fill="none" stroke="var(--an-ac)" strokeWidth="10" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" opacity=".12" />
                <path d={line} fill="none" stroke="url(#an-line)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              {n > 0 && (
                <>
                  <span className="an-lastglow" style={{ top: `${(pts[last][1] / H) * 100}%` }} />
                  <span className="an-lastdot" style={{ top: `${(pts[last][1] / H) * 100}%` }} />
                  {hover == null && <span className="an-lastlbl" style={{ top: `${(pts[last][1] / H) * 100}%` }}>{lastLabel}</span>}
                </>
              )}
              {tip && (
                <>
                  <span className="an-cross" style={{ left: `${tip.x}%` }} />
                  <span className="an-tipdot" style={{ left: `${tip.x}%`, top: `${tip.y}%` }} />
                  <div className="an-tip" style={{ left: `${tip.x}%`, transform: tip.x > 70 ? "translateX(calc(-100% - 14px))" : tip.x < 30 ? "translateX(14px)" : "translateX(-50%)" }}>
                    <span className="an-tiphead">{tipHead}</span>
                    <span className="an-tiprow"><span className="an-sw" style={{ background: "var(--an-ac)" }} />This period<b>{tip.cur.toLocaleString()}</b></span>
                    {compare && tip.prev != null && <span className="an-tiprow prev"><span className="an-sw" style={{ background: "var(--an-text3)" }} />Previous<b>{tip.prev.toLocaleString()}</b></span>}
                    {compare && tipDelta != null && <span className={"an-tipdelta " + (tipDelta >= 0 ? "up" : "down")}>{tipDelta >= 0 ? "▲" : "▼"} {Math.abs(tipDelta).toFixed(1)}%</span>}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="an-xaxis">
            {xIdx.map((i, k) => (
              <span key={i} style={{ left: `${n <= 1 ? 100 : (i / (n - 1)) * 100}%` }} className={k === 0 ? "first" : k === xIdx.length - 1 ? "last" : ""}>{labels[i]}</span>
            ))}
          </div>
        </>
      )}
      <div className="an-sums">
        <div className="an-sum"><span className="an-sumic">{IC.trend}</span><span><b>{compactNum(n ? cur[peak] : 0)}</b><span>Peak {unit}{n ? ` · ${labels[peak]}` : ""}</span></span></div>
        <div className="an-sum"><span className="an-sumic">{IC.bars}</span><span><b>{compactNum(Math.round(avg))}</b><span>{unitWord} average {metric}</span></span></div>
        {growth != null && (
          <div className="an-sum"><span className="an-sumic">{IC.rocket}</span><span><b>{growth >= 0 ? "+" : ""}{growth.toFixed(0)}%</b><span>First to last {unit}</span></span></div>
        )}
      </div>
    </section>
  );
}

function Donut({ rows, total, sub }: { rows: { id: string; name: string; v: number; share: number; c: string }[]; total: string; sub: string }) {
  const C = 2 * Math.PI * 40;
  const gap = rows.length > 1 ? 2.5 : 0;
  let cum = 0;
  return (
    <div className="an-donut">
      <svg viewBox="0 0 100 100" role="img" aria-label={rows.map((r) => `${r.name} ${Math.round(r.share)}%`).join(", ")}>
        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--an-sunk2)" strokeWidth="13" />
        {rows.map((r) => {
          const len = Math.max(0, (r.share / 100) * C - gap);
          const el = (
            <circle key={r.id} cx="50" cy="50" r="40" fill="none" stroke={r.c} strokeWidth="13"
              strokeDasharray={`${len.toFixed(2)} ${C.toFixed(2)}`} strokeDashoffset={(-cum).toFixed(2)}>
              <title>{`${r.name}: ${compactNum(r.v)} (${Math.round(r.share)}%)`}</title>
            </circle>
          );
          cum += (r.share / 100) * C;
          return el;
        })}
      </svg>
      <div className="an-donutc"><b>{total}</b><span>{sub}</span></div>
    </div>
  );
}

function FollowerCard({ now, days, today, scope }: { now: number | null; days: { day: string; total: number }[]; today: string; scope: string }) {
  const gains = days.slice(1).map((d, i) => ({ day: d.day, g: d.total - days[i].total }));
  const net = days.length > 1 ? days[days.length - 1].total - days[0].total : null;
  const maxAbs = Math.max(1, ...gains.map((x) => Math.abs(x.g)));
  const peak = gains.reduce((m, x) => Math.max(m, x.g), 0);
  return (
    <section className="an-card">
      <div className="an-hd"><b className="an-h">Follower growth</b><span>Day by day · last 30 days · {scope}</span></div>
      {now == null && !gains.length ? (
        <p className="an-none">No follower history yet. Connect Instagram, Facebook or YouTube in Settings, Channels &amp; Integrations, and it fills in day by day.</p>
      ) : (
        <>
          <div className="an-fgtop">
            <b>{now == null ? "—" : compactNum(now)}</b>
            {net != null && <span className={"an-pill " + (net >= 0 ? "up" : "down")}>{net >= 0 ? "+" : "−"}{compactNum(Math.abs(net))} in {gains.length} days</span>}
            {net != null && gains.length > 0 && <span className="an-muted">≈{Math.round(net / gains.length).toLocaleString()} a day</span>}
          </div>
          {gains.length > 0 ? (
            <>
              <div className="an-fgbars">
                {gains.map((x, i) => (
                  <span key={x.day} title={`${shortDate(x.day)}: ${x.g >= 0 ? "+" : ""}${x.g.toLocaleString()}`}
                    className={x.g < 0 ? "loss" : x.g === peak && peak > 0 ? "peak" : i === gains.length - 1 ? "last" : ""}
                    style={{ height: `${Math.max(4, (Math.abs(x.g) / maxAbs) * 100)}%` }} />
                ))}
              </div>
              <div className="an-fgx">
                <span>{shortDate(gains[0].day)}</span>
                <span>{shortDate(gains[Math.floor(gains.length / 2)].day)}</span>
                <span>{gains[gains.length - 1].day === today ? "Today" : shortDate(gains[gains.length - 1].day)}</span>
              </div>
            </>
          ) : <p className="an-none">Day-by-day history starts after the next sync.</p>}
        </>
      )}
    </section>
  );
}

function Breakdown({ title, sub, rows }: { title: string; sub: string; rows: { name: string; v: number; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <section className="an-card">
      <div className="an-hd"><b className="an-h">{title}</b><span>{sub}</span></div>
      {rows.length ? rows.map((r) => (
        <div key={r.name} className="an-brow" title={`${r.name}: ${r.v.toLocaleString()} views from ${r.n} post${r.n === 1 ? "" : "s"}`}>
          <span className="an-bname">{r.name}</span>
          <span className="an-btrack"><span style={{ width: `${(r.v / max) * 100}%` }} /></span>
          <b>{compactNum(r.v)}</b>
          <span className="an-muted">{r.n} post{r.n === 1 ? "" : "s"}</span>
        </div>
      )) : <p className="an-none">No views in this range yet.</p>}
    </section>
  );
}

function Thumb({ p, big }: { p: P; big?: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={"an-thumb" + (big ? " big" : "")} style={{ background: `linear-gradient(160deg, ${p.post_type === "reel" ? "var(--an-s1)" : "var(--an-s2)"}, #1a1530)` }}>
      {p.thumbnail_url && !broken
        ? <img src={p.thumbnail_url} alt="" loading="lazy" onError={() => setBroken(true)} />
        : (p.post_type === "reel" ? IC.play : IC.carousel)}
    </span>
  );
}

const MEDAL = ["var(--an-gold)", "var(--an-silver)", "var(--an-bronze)"];

function TopContent({ posts, platformName, onOpen, onAll, scopeName }: {
  posts: P[]; platformName: (id: string | null) => string; onOpen: (p: P) => void; onAll: () => void; scopeName: string;
}) {
  const ranked = useMemo(() => [...posts].filter((p) => p.reach > 0).sort((a, b) => performanceScore(b) - performanceScore(a)).slice(0, 3), [posts]);
  const best = ranked.length ? performanceScore(ranked[0]) : 0;
  return (
    <section className="an-card">
      <div className="an-charthead">
        <div className="an-hd"><b className="an-h lg">Top content</b><span>Ranked by performance score · {scopeName}</span></div>
        <span className="an-grow" />
        <button type="button" className="an-btn" onClick={onAll}>{IC.grid}All posts</button>
      </div>
      {ranked.length ? (
        <div className="an-top3">
          {ranked.map((p, i) => {
            const sc = performanceScore(p);
            return (
              <button key={p.id} type="button" className="an-topcard" onClick={() => onOpen(p)} style={{ "--medal": MEDAL[i] } as CSSProperties}>
                <Thumb p={p} />
                <span className="an-rank">{i + 1}</span>
                <span className="an-topbody">
                  <b className="an-toptitle">{p.title}</b>
                  <span className="an-topmeta">{[platformName(p.platform_id), TYPE_LABEL[p.post_type], shortDate(p.date)].filter(Boolean).join(" · ")}</span>
                  <span className="an-topnums">
                    <span><b>{compactNum(p.views)}</b><span>views</span></span>
                    <span><b>{pct(rateOf(engOf(p), p.reach))}</b><span>eng.</span></span>
                    <span className="an-grow" />
                    <span className="an-ring" title={`Performance score ${Math.round(sc).toLocaleString()}. The ring compares it with the best post here.`}>
                      <svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--an-sunk2)" strokeWidth="4.5" />
                        <circle cx="22" cy="22" r="18" fill="none" stroke="var(--an-good)" strokeWidth="4.5" strokeLinecap="round" strokeDasharray={`${((best ? sc / best : 0) * 113.1).toFixed(1)} 113.1`} /></svg>
                      <b>{compactNum(Math.round(sc))}</b>
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : <p className="an-none">No published posts with reach in this range yet.</p>}
    </section>
  );
}

type MetKey = "er" | "views" | "reach" | "saves" | "shares";
const METRICS: { k: MetKey; l: string; icon: ReactNode }[] = [
  { k: "er", l: "Engagement rate", icon: IC.heart }, { k: "views", l: "Views", icon: IC.eye },
  { k: "reach", l: "Reach", icon: IC.users }, { k: "saves", l: "Saves", icon: IC.bookmark }, { k: "shares", l: "Shares", icon: IC.send },
];
const metValue = (p: Post, k: MetKey) => (k === "er" ? rateOf(engOf(p), p.reach) : p[k]);
const metText = (p: Post, k: MetKey) => (k === "er" ? (p.reach ? pct(rateOf(engOf(p), p.reach)) : "—") : compactNum(p[k]));

function TopPerformers({ posts, editors, platformName, onOpen }: {
  posts: P[]; editors: { id: string; name: string; image_url: string | null }[];
  platformName: (id: string | null) => string; onOpen: (p: P) => void;
}) {
  const [metric, setMetric] = useState<MetKey>("er");
  const [type, setType] = useState<"all" | "reel" | "carousel">("all");
  const [shown, setShown] = useState(20);
  const ranked = useMemo(() => posts
    .filter((p) => (type === "all" || p.post_type === type) && (metric !== "er" || p.reach > 0))
    .sort((a, b) => metValue(b, metric) - metValue(a, metric)), [posts, type, metric]);
  const label = METRICS.find((m) => m.k === metric)!.l;
  const editorOf = (id: string | null) => editors.find((e) => e.id === id) ?? null;
  const cols: MetKey[] = ["views", "reach", "saves", "shares", "er"];
  const pod = ranked.slice(0, 3);

  const Ed = ({ id }: { id: string | null }) => {
    const e = editorOf(id);
    if (!e) return <span className="an-muted">—</span>;
    return (
      <span className="an-ed">
        {e.image_url ? <img src={e.image_url} alt="" /> : <span style={{ background: gradFor(e.name) }}>{e.name.charAt(0).toUpperCase()}</span>}
        {e.name.split(" ")[0]}
      </span>
    );
  };

  return (
    <div className="an-stack">
      <div className="an-tophead">
        <div className="an-hd"><b className="an-h xl">Top performers</b><span>{ranked.length} post{ranked.length === 1 ? "" : "s"} ranked by {label.toLowerCase()}</span></div>
        <span className="an-grow" />
        <div className="an-seg">
          {([["all", "All"], ["reel", "Reels"], ["carousel", "Carousels"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={type === k ? "on" : ""} onClick={() => setType(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="an-chips">
        {METRICS.map((m) => (
          <button key={m.k} type="button" className={metric === m.k ? "on" : ""} onClick={() => setMetric(m.k)} aria-pressed={metric === m.k}>{m.icon}{m.l}</button>
        ))}
      </div>
      {!ranked.length ? (
        <div className="an-card an-empty">No published posts in this range yet. Sync a connected account or log some metrics, then come back.</div>
      ) : (
        <>
          <div className="an-podium">
            {pod.map((p, i) => (
              <button key={p.id} type="button" className={"an-pod p" + (i + 1)} onClick={() => onOpen(p)} style={{ "--medal": MEDAL[i] } as CSSProperties}>
                <span className="an-podthumb">
                  <Thumb p={p} big />
                  <span className="an-podrank">{i + 1}</span>
                  <span className="an-podtag">{[TYPE_LABEL[p.post_type], platformName(p.platform_id)].filter(Boolean).join(" · ")}</span>
                </span>
                <b className="an-toptitle">{p.title}</b>
                <span className="an-podmeta">{[p.channel_name, shortDate(p.date)].filter(Boolean).join(" · ")}<Ed id={p.editor_id} /></span>
                <span className="an-podval"><b>{metText(p, metric)}</b><span>{label}</span></span>
                <span className="an-podmini">
                  {METRICS.filter((m) => m.k !== metric).map((m) => (
                    <span key={m.k}><b>{metText(p, m.k)}</b><span>{m.k === "er" ? "Eng." : m.l}</span></span>
                  ))}
                </span>
              </button>
            ))}
          </div>
          {ranked.length > 3 && (
            <section className="an-card an-flush">
              <div className="an-tablewrap">
                <div className="an-rank-table">
                  <div className="an-rt-head">
                    <span>#</span><span>Post</span><span>Editor</span>
                    {cols.map((k) => <span key={k} className={"num" + (k === metric ? " on" : "")}>{k === "er" ? "Eng. rate" : METRICS.find((m) => m.k === k)!.l}</span>)}
                  </div>
                  {ranked.slice(3, shown).map((p, i) => (
                    <button key={p.id} type="button" className="an-rt-row" onClick={() => onOpen(p)}>
                      <b className="an-muted">{i + 4}</b>
                      <span className="an-rt-post">
                        <Thumb p={p} />
                        <span><b>{p.title}</b><span>{[p.channel_name, TYPE_LABEL[p.post_type], shortDate(p.date)].filter(Boolean).join(" · ")}</span></span>
                      </span>
                      <Ed id={p.editor_id} />
                      {cols.map((k) => <span key={k} className={"num" + (k === metric ? " on" : "")}>{metText(p, k)}</span>)}
                    </button>
                  ))}
                </div>
              </div>
              {ranked.length > shown && (
                <button type="button" className="an-showmore" onClick={() => setShown((s) => s + 20)}>Show {Math.min(20, ranked.length - shown)} more</button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
