import { useMemo, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell,
} from "recharts";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import { compactNum } from "@/lib/date-range";
import { performanceScore } from "@/lib/score";
import type { Post, Platform } from "@/lib/types";

// ---- date helpers (local; Monday-based weeks to match the weekly rollup) ----
function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function startOfWeek(d: Date) { const c = new Date(d); return addDays(c, -((c.getDay() + 6) % 7)); }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Bucket = { key: string; label: string; from: string; to: string };

// The last 12 buckets ending today, so the axis is continuous even where a
// period has no posts (zero-filled).
function buildBuckets(granularity: "week" | "month"): Bucket[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out: Bucket[] = [];
  if (granularity === "week") {
    const thisWeek = startOfWeek(today);
    for (let i = 11; i >= 0; i--) {
      const s = addDays(thisWeek, -7 * i);
      const e = addDays(s, 6);
      out.push({ key: iso(s), label: `${MONTHS[s.getMonth()]} ${s.getDate()}`, from: iso(s), to: iso(e) });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const s = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const e = new Date(s.getFullYear(), s.getMonth() + 1, 0);
      out.push({ key: `${s.getFullYear()}-${s.getMonth()}`, label: `${MONTHS[s.getMonth()]}${s.getMonth() === 0 ? " " + String(s.getFullYear()).slice(2) : ""}`, from: iso(s), to: iso(e) });
    }
  }
  return out;
}

const METRICS = [
  { key: "views", label: "Views", fmt: compactNum },
  { key: "engagement", label: "Engagement", fmt: compactNum },
  { key: "score", label: "Avg Score", fmt: (n: number) => Math.round(n).toLocaleString() },
  { key: "posts", label: "Posts", fmt: (n: number) => String(n) },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

const PLATFORM_COLOR: Record<string, string> = {
  instagram: "#c13584", facebook: "#1877f2", youtube: "#ff2d2d",
};
const PLATFORM_ICON: Record<string, string> = { instagram: "📸", facebook: "👍", youtube: "▶️" };

const engOf = (p: Post) => p.likes + p.comments + p.shares + p.saves;

// Aggregate a set of published posts into the metric numbers a bucket needs.
function agg(posts: Post[]) {
  const views = posts.reduce((a, p) => a + p.views, 0);
  const reach = posts.reduce((a, p) => a + p.reach, 0);
  const engagement = posts.reduce((a, p) => a + engOf(p), 0);
  const scored = posts.filter((p) => p.reach > 0);
  const score = scored.length ? scored.reduce((a, p) => a + performanceScore(p), 0) / scored.length : 0;
  return { views, reach, engagement, posts: posts.length, score, engRate: reach ? (engagement / reach) * 100 : 0 };
}

function ChartTip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="ct-label">{label}</div>
      <div className="ct-val">{fmt(payload[0].value)}</div>
    </div>
  );
}

function Delta({ curr, prev }: { curr: number; prev: number }) {
  if (prev === 0) {
    if (curr === 0) return <span className="tr-delta flat">— no change</span>;
    return <span className="tr-delta up">▲ new</span>;
  }
  const pct = Math.round(((curr - prev) / prev) * 100);
  if (pct === 0) return <span className="tr-delta flat">— flat vs prev</span>;
  return <span className={"tr-delta " + (pct > 0 ? "up" : "down")}>{pct > 0 ? "▲" : "▼"} {Math.abs(pct)}% vs prev</span>;
}

export function TrendsPage() {
  const { workspaces } = useWorkspaces();
  const [channel, setChannel] = useState("all");
  const [granularity, setGranularity] = useState<"week" | "month">("week");
  const [metric, setMetric] = useState<MetricKey>("views");

  const { data: postData, loading } = useResource<{ posts: Post[] }>(`/posts?channel=${channel}`);
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const posts = postData?.posts ?? [];
  const platforms = platData?.platforms ?? [];

  const published = useMemo(() => posts.filter((p) => p.status === "published"), [posts]);
  const buckets = useMemo(() => buildBuckets(granularity), [granularity]);

  // Per-bucket aggregates.
  const series = useMemo(() => {
    return buckets.map((b) => {
      const inBucket = published.filter((p) => p.date >= b.from && p.date <= b.to);
      return { ...b, ...agg(inBucket) };
    });
  }, [buckets, published]);

  const chartData = useMemo(
    () => series.map((s) => ({ label: s.label, value: s[metric] as number })),
    [series, metric],
  );
  const activeMetric = METRICS.find((m) => m.key === metric)!;

  // Summary cards: current bucket vs the previous one (this week/month vs last).
  const curr = series[series.length - 1];
  const prev = series[series.length - 2] ?? { views: 0, engagement: 0, score: 0, posts: 0 };
  const periodWord = granularity === "week" ? "week" : "month";

  // Platform comparison across the whole visible window.
  const windowFrom = buckets[0]?.from ?? null;
  const platformRows = useMemo(() => {
    const scoped = published.filter((p) => !windowFrom || p.date >= windowFrom);
    return platforms
      .map((pf) => {
        const rows = scoped.filter((p) => p.platform_id === pf.id);
        return { platform: pf, ...agg(rows) };
      })
      .filter((r) => r.posts > 0)
      .sort((a, b) => b.views - a.views);
  }, [platforms, published, windowFrom]);
  const maxPlatViews = Math.max(1, ...platformRows.map((r) => r.views));

  const hasData = published.length > 0;

  return (
    <section className="screen">
      {/* Toolbar */}
      <div className="toolbar" style={{ alignItems: "center" }}>
        <select className="t chan-sel" style={{ maxWidth: 220 }} value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">🌐 All Channels</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <div className="spacer" />
        <div className="seg" style={{ marginBottom: 0 }}>
          {(["week", "month"] as const).map((g) => (
            <button key={g} className={granularity === g ? "on" : ""} onClick={() => setGranularity(g)}>
              {g === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      </div>

      {/* Trend summary — this period vs last */}
      <div className="grid g4">
        {METRICS.map((m) => (
          <div className="card kpi tr-kpi" key={m.key}>
            <div className="l">{m.label} · this {periodWord}</div>
            <div className="v">{loading ? "—" : m.fmt((curr?.[m.key] as number) ?? 0)}</div>
            <Delta curr={(curr?.[m.key] as number) ?? 0} prev={(prev?.[m.key] as number) ?? 0} />
          </div>
        ))}
      </div>

      {/* Main trend chart */}
      <div className="sectitle"><span className="dot" />Performance over time
        <span className="s">last 12 {granularity === "week" ? "weeks" : "months"}</span>
      </div>
      <div className="card pad">
        <div className="tr-metricrow">
          {METRICS.map((m) => (
            <button key={m.key} className={"tr-chip" + (metric === m.key ? " on" : "")} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
        {!hasData ? (
          <div className="tr-empty">No published posts yet — trends will appear as you log metrics.</div>
        ) : (
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <AreaChart data={chartData} margin={{ top: 10, right: 8, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="trFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a855f7" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "rgba(148,163,184,0.2)" }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => compactNum(Number(v))} />
                <Tooltip content={<ChartTip fmt={activeMetric.fmt} />} cursor={{ stroke: "#a855f7", strokeWidth: 1, strokeDasharray: "4 4" }} />
                <Area type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2.5} fill="url(#trFill)" dot={{ r: 3, fill: "#a855f7", strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Platform comparison */}
      <div className="sectitle"><span className="dot" />Platform comparison
        <span className="s">{channel === "all" ? "all channels" : "selected channel"} · this window</span>
      </div>
      {platformRows.length === 0 ? (
        <div className="card pad tr-empty">No platform data in this window yet.</div>
      ) : (
        <div className="grid g2" style={{ alignItems: "stretch" }}>
          <div className="card pad">
            <div className="sectitle" style={{ margin: "0 0 10px" }}><span className="dot" />Views by platform</div>
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={platformRows.map((r) => ({ name: r.platform.name, key: r.platform.key, views: r.views }))} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "rgba(148,163,184,0.2)" }} />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => compactNum(Number(v))} />
                  <Tooltip content={<ChartTip fmt={compactNum} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                  <Bar dataKey="views" radius={[8, 8, 0, 0]} maxBarSize={80}>
                    {platformRows.map((r) => (
                      <Cell key={r.platform.id} fill={PLATFORM_COLOR[r.platform.key] ?? "#a855f7"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card pad">
            <div className="sectitle" style={{ margin: "0 0 10px" }}><span className="dot" />Head-to-head</div>
            <div className="tr-table">
              <div className="tr-thead">
                <span>Platform</span><span>Posts</span><span>Views</span><span>Eng. rate</span><span>Avg score</span>
              </div>
              {platformRows.map((r) => (
                <div className="tr-trow" key={r.platform.id}>
                  <span className="tr-pf">
                    <span className="tr-pfic" style={{ background: PLATFORM_COLOR[r.platform.key] ?? "#a855f7" }}>{PLATFORM_ICON[r.platform.key] ?? "📱"}</span>
                    {r.platform.name}
                  </span>
                  <span>{r.posts}</span>
                  <span>{compactNum(r.views)}</span>
                  <span>{r.engRate.toFixed(1)}%</span>
                  <span><b>{Math.round(r.score).toLocaleString()}</b></span>
                </div>
              ))}
              <div className="tr-barwrap">
                {platformRows.map((r) => (
                  <div className="tr-barrow" key={r.platform.id}>
                    <span className="tr-barname">{r.platform.name}</span>
                    <div className="tr-bartrack"><div className="tr-barfill" style={{ width: `${(r.views / maxPlatViews) * 100}%`, background: PLATFORM_COLOR[r.platform.key] ?? "#a855f7" }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="demo-note" style={{ marginTop: 18 }}>
        ↪ Trends & platform comparison are computed live from your published posts. Log each post's metrics to sharpen them.
      </div>
    </section>
  );
}
