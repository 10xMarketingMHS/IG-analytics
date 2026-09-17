import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import type { Post, Platform, Account } from "@/lib/types";

// One platform connection's follower figures for the dashboard card: the current
// count plus its value as of the selected range's start/end (from the snapshot
// timeline; null when no snapshot exists yet for that date).
type FollowerRow = {
  connectionId: string; provider: string; externalId: string; platformKey: string; channelId: string;
  current: number | null; atFrom: number | null; atTo: number | null;
};
// One day's follower snapshot for an account, for the day-by-day growth view.
type FollowerDaily = {
  connectionId: string; provider: string; externalId: string; platformKey: string; channelId: string;
  day: string; followerCount: number;
};

// The same real account (FB Page / IG account) can be connected to more than one
// channel; when aggregating we must count each account ONCE. external_id is the
// account's real id, so dedupe on it before summing.
function dedupeByAccount<T extends { externalId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
}

const PLATFORM_ICON: Record<string, string> = {
  instagram: "📸", facebook: "👍", youtube: "▶️",
};
const PLATFORM_GRAD: Record<string, string> = {
  instagram: "linear-gradient(135deg,#f9737d,#c13584,#833ab4)",
  facebook: "linear-gradient(135deg,#1877f2,#0a5bd3)",
  youtube: "linear-gradient(135deg,#ff4e45,#c4302b)",
};
import {
  RANGE_PRESETS, rangeFor, previousRange, inRange, labelFor, compactNum,
  type RangeKey,
} from "@/lib/date-range";
import { performanceScore, formatScore } from "@/lib/score";

function engagementOf(p: Post) {
  return p.likes + p.comments + p.shares + p.saves;
}

export function DashboardPage() {
  const { taxonomy } = useTaxonomy();
  const navigate = useNavigate();
  const { workspaces } = useWorkspaces();
  // Channel scope: "all" aggregates every channel in the Media House, or a
  // specific channel id. Drives the cross-channel analytics.
  const [channel, setChannel] = useState<string>("all");
  const { data: postData } = useResource<{ posts: Post[] }>(`/posts?channel=${channel}`);
  const allPosts = postData?.posts ?? null;
  // Which platforms exist for the selected channel scope (drives the cards).
  const { data: acctData } = useResource<{ accounts: Account[] }>(`/accounts?channel=${channel}`);
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const [platformId, setPlatformId] = useState<string>("");
  const [range, setRange] = useState<RangeKey>("all");

  const channelPlatforms = useMemo<Platform[]>(() => {
    const ids = new Set((acctData?.accounts ?? []).map((a) => a.platform_id));
    return (platData?.platforms ?? []).filter((p) => ids.has(p.id));
  }, [acctData, platData]);

  // Auto-select the first available platform; re-select when the channel change
  // makes the current platform unavailable.
  useEffect(() => {
    if (channelPlatforms.length && !channelPlatforms.find((p) => p.id === platformId)) {
      setPlatformId(channelPlatforms[0].id);
    }
  }, [channelPlatforms, platformId]);

  // Everything below analyzes the selected platform only.
  const posts = useMemo<Post[] | null>(
    () => (allPosts === null ? null : allPosts.filter((p) => p.platform_id === platformId)),
    [allPosts, platformId],
  );
  const activePlatform = channelPlatforms.find((p) => p.id === platformId);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [popOpen, setPopOpen] = useState(false);
  const [fromInput, setFromInput] = useState("2026-06-01");
  const [toInput, setToInput] = useState("2026-06-30");

  const bounds = range === "custom" && custom ? custom : rangeFor(range);

  // Follower count for the selected platform + channel, from the follower_snapshot
  // timeline: the count AS OF the range end, and growth over the range. "All time"
  // (no bounds) shows the current total with no growth. Scoped to the chosen
  // platform; "All Channels" sums that platform's connections across channels.
  const folUrl = useMemo(() => {
    const q = new URLSearchParams();
    if (bounds.from) q.set("from", bounds.from);
    if (bounds.to) q.set("to", bounds.to);
    return `/integrations/followers${q.toString() ? `?${q}` : ""}`;
  }, [bounds.from, bounds.to]);
  const { data: folData } = useResource<{ followers: FollowerRow[] }>(folUrl);
  const followers = useMemo<{ count: number | null; growth: number | null }>(() => {
    const key = activePlatform?.key;
    if (!key) return { count: null, growth: null };
    const rel = dedupeByAccount((folData?.followers ?? []).filter(
      (f) => f.platformKey === key && (channel === "all" || f.channelId === channel) && f.current != null,
    ));
    if (!rel.length) return { count: null, growth: null };
    // Show the current follower total; growth is the change since the start of
    // the selected range (current − the count as of `from`). Growth only when
    // every account has a baseline snapshot for that date (else null).
    const count = rel.reduce((s, f) => s + (f.current ?? 0), 0);
    const haveBaseline = !!bounds.from && rel.every((f) => f.atFrom != null);
    const growth = haveBaseline ? count - rel.reduce((s, f) => s + (f.atFrom ?? 0), 0) : null;
    return { count, growth };
  }, [folData, activePlatform, channel, bounds.from]);

  // Combined follower total across EVERY connected platform (IG + FB + YouTube)
  // for the channel scope — the whole audience, not just the selected platform.
  const totalFollowers = useMemo<{ count: number | null; growth: number | null }>(() => {
    const rel = dedupeByAccount((folData?.followers ?? []).filter(
      (f) => (channel === "all" || f.channelId === channel) && f.current != null,
    ));
    if (!rel.length) return { count: null, growth: null };
    const count = rel.reduce((s, f) => s + (f.current ?? 0), 0);
    const haveBaseline = !!bounds.from && rel.every((f) => f.atFrom != null);
    const growth = haveBaseline ? count - rel.reduce((s, f) => s + (f.atFrom ?? 0), 0) : null;
    return { count, growth };
  }, [folData, channel, bounds.from]);

  // Day-by-day follower growth for the selected platform + channel scope. For
  // each day we carry each account's latest known count forward, sum across the
  // scope, then take the gain/loss vs the previous day. Most recent first.
  const { data: dailyData } = useResource<{ series: FollowerDaily[] }>("/integrations/followers/daily?days=30");
  const dailyGrowth = useMemo<{ day: string; total: number; delta: number | null }[]>(() => {
    const key = activePlatform?.key;
    if (!key) return [];
    const rows = (dailyData?.series ?? []).filter(
      (r) => r.platformKey === key && (channel === "all" || r.channelId === channel),
    );
    if (!rows.length) return [];
    // Key by account (external_id), not connection, so the same page connected to
    // multiple channels isn't counted twice per day.
    const byConn = new Map<string, Map<string, number>>();
    const daySet = new Set<string>();
    for (const r of rows) {
      if (!byConn.has(r.externalId)) byConn.set(r.externalId, new Map());
      byConn.get(r.externalId)!.set(r.day, r.followerCount);
      daySet.add(r.day);
    }
    const days = [...daySet].sort();
    // Per day, sum each account's latest count on-or-before that day (accounts
    // with no snapshot yet don't contribute).
    const totals = days.map((day) => {
      let sum = 0, any = false;
      for (const m of byConn.values()) {
        let best: number | null = null, bestDay = "";
        for (const [d, val] of m) if (d <= day && d > bestDay) { best = val; bestDay = d; }
        if (best != null) { sum += best; any = true; }
      }
      return { day, total: any ? sum : null };
    });
    const out: { day: string; total: number; delta: number | null }[] = [];
    for (let i = 0; i < totals.length; i++) {
      if (totals[i].total == null) continue;
      const prev = i > 0 ? totals[i - 1].total : null;
      out.push({ day: totals[i].day, total: totals[i].total as number, delta: prev != null ? (totals[i].total as number) - prev : null });
    }
    return out.reverse(); // most recent first
  }, [dailyData, activePlatform, channel]);

  // Analytics count Published posts only (PRD FR-N8).
  const published = useMemo(
    () => (posts ?? []).filter((p) => p.status === "published"),
    [posts],
  );
  const scoped = useMemo(
    () => published.filter((p) => inRange(p.date, bounds.from, bounds.to)),
    [published, bounds.from, bounds.to],
  );

  // Collab mirrors never count toward PERFORMANCE (views/reach/eng/score) — that
  // would double-count the same audience. They DO count toward COUNT / content-
  // mix, but only when viewing a single channel (its own copy); on "All
  // Channels" a collab post is still one post, so mirrors are dropped there too.
  const noMirror = (arr: Post[]) => arr.filter((p) => !p.is_collab_mirror);
  const scopedPerf = useMemo(() => noMirror(scoped), [scoped]);
  const publishedPerf = useMemo(() => noMirror(published), [published]);
  const scopedCount = useMemo(() => (channel === "all" ? noMirror(scoped) : scoped), [scoped, channel]);

  // Per-platform post/view totals for the cards (same channel scope + range).
  const platformSummary = useMemo(() => {
    const m = new Map<string, { posts: number; views: number }>();
    for (const p of allPosts ?? []) {
      if (p.status !== "published" || !inRange(p.date, bounds.from, bounds.to)) continue;
      const key = p.platform_id ?? "";
      const cur = m.get(key) ?? { posts: 0, views: 0 };
      if (!(p.is_collab_mirror && channel === "all")) cur.posts += 1; // count: mirror only on scoped
      if (!p.is_collab_mirror) cur.views += p.views;                  // views: mirror never
      m.set(key, cur);
    }
    return m;
  }, [allPosts, bounds.from, bounds.to, channel]);

  const sum = (arr: Post[], f: (p: Post) => number) => arr.reduce((a, p) => a + f(p), 0);
  const views = sum(scopedPerf, (p) => p.views);
  const reach = sum(scopedPerf, (p) => p.reach);
  const eng = sum(scopedPerf, engagementOf);
  const engRate = reach ? ((eng / reach) * 100).toFixed(1) + "%" : "—";

  // Period-over-period growth for Views & Reach (PRD §10.4).
  let viewsDelta: number | null = null;
  let reachDelta: number | null = null;
  if (bounds.from && bounds.to) {
    const prev = previousRange(bounds.from, bounds.to);
    const prevScoped = publishedPerf.filter((p) => inRange(p.date, prev.from, prev.to));
    const pv = sum(prevScoped, (p) => p.views);
    const pr = sum(prevScoped, (p) => p.reach);
    viewsDelta = pv ? Math.round(((views - pv) / pv) * 100) : null;
    reachDelta = pr ? Math.round(((reach - pr) / pr) * 100) : null;
  }

  const byGroup = (getId: (p: Post) => string, list?: { id: string; name: string }[]) => {
    const totals = new Map<string, number>();
    for (const p of scopedPerf) totals.set(getId(p), (totals.get(getId(p)) ?? 0) + p.views);
    const rows = (list ?? []).map((x) => ({ name: x.name, views: totals.get(x.id) ?? 0 }));
    return rows.filter((r) => r.views > 0).sort((a, b) => b.views - a.views).slice(0, 8);
  };
  const byPillar = byGroup((p) => p.pillar_id, taxonomy?.pillars);
  const byAvatar = byGroup((p) => p.avatar_id, taxonomy?.avatars);
  const maxPillar = Math.max(1, ...byPillar.map((r) => r.views));
  const maxAvatar = Math.max(1, ...byAvatar.map((r) => r.views));

  // Content mix: counts are scope-conditional; views stay performance-only.
  const reels = scopedCount.filter((p) => p.post_type === "reel").length;
  const carousels = scopedCount.filter((p) => p.post_type === "carousel").length;
  const reelViews = sum(scopedPerf.filter((p) => p.post_type === "reel"), (p) => p.views);
  const carouselViews = sum(scopedPerf.filter((p) => p.post_type === "carousel"), (p) => p.views);
  const mixTotal = reels + carousels;
  const reelPct = mixTotal ? Math.round((reels / mixTotal) * 100) : 0;

  // Best performer = highest Performance Score (PRD scoring spec).
  const best = (type: "reel" | "carousel") =>
    scopedPerf
      .filter((p) => p.post_type === type)
      .sort((a, b) => performanceScore(b) - performanceScore(a))[0];
  const bestReel = best("reel");
  const bestCarousel = best("carousel");
  const pillarName = (id: string) => taxonomy?.pillars.find((p) => p.id === id)?.name ?? "—";

  const rangeLabel = range === "custom" ? "Custom" : labelFor(range);

  function applyCustom() {
    setCustom({ from: fromInput, to: toInput });
    setRange("custom");
    setPopOpen(false);
  }

  // [icon, label, value, kind, deltaValue] — deltaValue rides on the tuple so the
  // render doesn't couple deltas to card positions.
  // % change vs the previous period (Views / Reach); absolute count for Followers.
  const pctDelta = (d: number | null) => (d == null ? " " : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}% vs prev`);
  const folDelta = followers.growth == null
    ? " "
    : `${followers.growth >= 0 ? "▲" : "▼"} ${followers.growth >= 0 ? "+" : "-"}${compactNum(Math.abs(followers.growth))} in ${rangeLabel}`;

  const kpis: [string, string, string, string | null, string][] = [
    ["📝", "Total Posts", String(scopedCount.length), null, " "],
    ["👥", "Followers", followers.count == null ? "—" : compactNum(followers.count),
      followers.growth == null ? null : (followers.growth >= 0 ? "up" : "down"), folDelta],
    ["👁️", "Total Views", compactNum(views), viewsDelta == null ? null : (viewsDelta >= 0 ? "up" : "down"), pctDelta(viewsDelta)],
    ["📡", "Accounts Reached", compactNum(reach), reachDelta == null ? null : (reachDelta >= 0 ? "up" : "down"), pctDelta(reachDelta)],
    ["⚡", "Engagement Rate", engRate, "flat", " "],
  ];

  return (
    <section className="screen">
      <div className="toolbar" style={{ alignItems: "center" }}>
        <select
          className="t chan-sel"
          style={{ maxWidth: 220 }}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          title="Choose a channel"
        >
          <option value="all">🌐 All Channels</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <div className="hint" style={{ margin: 0 }}>
          Showing <b style={{ color: "var(--text)" }}>{rangeLabel}</b> · {scopedCount.length} post{scopedCount.length === 1 ? "" : "s"}
        </div>
        <div className="spacer" />
        <div style={{ position: "relative" }}>
          <button className="rangebtn" onClick={() => setPopOpen((o) => !o)}>
            <span>🗓️ {rangeLabel}</span><span className="cv">▾</span>
          </button>
          <div className={"rangepop" + (popOpen ? " show" : "")} onClick={(e) => e.stopPropagation()}>
            <div className="rangepresets">
              {RANGE_PRESETS.map(([k, label]) => (
                <button
                  key={k}
                  className={"rp" + (range === k ? " on" : "")}
                  onClick={() => { setRange(k); setPopOpen(false); }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="rpcustom">
              <h5>Custom range</h5>
              <div><label>From</label><input type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} /></div>
              <div><label>To</label><input type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} /></div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "auto" }}>
                <button className="btn" onClick={() => setPopOpen(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={applyCustom}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="sectitle" style={{ marginTop: 6 }}>
        <span className="dot" />Platforms
        {totalFollowers.count != null ? (
          <span className="s">
            👥 {compactNum(totalFollowers.count)} total followers across all platforms
            {totalFollowers.growth != null ? ` · ${totalFollowers.growth >= 0 ? "▲ +" : "▼ -"}${compactNum(Math.abs(totalFollowers.growth))} in ${rangeLabel}` : ""}
          </span>
        ) : (
          <span className="s">click a platform to see its analytics</span>
        )}
      </div>
      {channelPlatforms.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          No platforms set up for this channel yet.
        </div>
      ) : (
        <div className="plat-cards">
          {channelPlatforms.map((pf) => {
            const sum = platformSummary.get(pf.id) ?? { posts: 0, views: 0 };
            const on = pf.id === platformId;
            return (
              <button key={pf.id} className={"plat-card" + (on ? " on" : "")} onClick={() => setPlatformId(pf.id)}>
                <div className="plat-ic" style={{ background: PLATFORM_GRAD[pf.key] ?? "var(--grad)" }}>
                  {PLATFORM_ICON[pf.key] ?? "📱"}
                </div>
                <div className="plat-name">{pf.name}</div>
                <div className="plat-sum">{sum.posts} post{sum.posts === 1 ? "" : "s"} · {compactNum(sum.views)} views</div>
                <div className="plat-go">{on ? "Viewing ▾" : "View analytics →"}</div>
              </button>
            );
          })}
        </div>
      )}

      <div className="sectitle">
        <span className="dot" />
        {activePlatform ? `${activePlatform.name} analytics` : "Analytics"}
        <span className="s">{rangeLabel} · {scopedCount.length} post{scopedCount.length === 1 ? "" : "s"}</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        {kpis.map(([ic, l, v, kind, dv]) => (
          <div className="card kpi" key={l}>
            <div className="ic">{ic}</div>
            <div className="l">{l}</div>
            <div className="v">{v}</div>
            <div className={"d " + (kind ?? "flat")}>{dv}</div>
          </div>
        ))}
      </div>

      {dailyGrowth.length > 0 && (
        <>
          <div className="sectitle">
            <span className="dot" />Follower growth · day by day
            <span className="s">{activePlatform ? activePlatform.name : ""} · followers gained / lost each day vs the day before</span>
          </div>
          <div className="card pad" style={{ overflowX: "auto" }}>
            <table className="tbl fol-daily">
              <thead><tr><th>Day</th><th className="num">Followers</th><th className="num">Change</th></tr></thead>
              <tbody>
                {dailyGrowth.map((d) => (
                  <tr key={d.day}>
                    <td>{new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</td>
                    <td className="num">{compactNum(d.total)}</td>
                    <td className="num">
                      {d.delta == null ? <span className="fol-flat">—</span>
                        : d.delta > 0 ? <span className="fol-up">▲ +{d.delta.toLocaleString()}</span>
                          : d.delta < 0 ? <span className="fol-down">▼ {d.delta.toLocaleString()}</span>
                            : <span className="fol-flat">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="sectitle"><span className="dot" />Views by format<span className="s">click a card for the full breakdown</span></div>
      <div className="grid g2">
        {[
          { type: "reel" as const, icon: "🎬", label: "Reel Views", v: reelViews, n: reels, accent: "var(--indigo)", weak: "var(--indigo-weak)" },
          { type: "carousel" as const, icon: "🖼️", label: "Carousel Views", v: carouselViews, n: carousels, accent: "var(--accent-ink)", weak: "var(--accent-weak)" },
        ].map((f) => (
          <button
            key={f.type}
            className="card kpi"
            onClick={() => navigate(`/analytics/${f.type}`)}
            style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }}
            title={`View all ${f.label.toLowerCase()} analytics`}
          >
            <div className="ic" style={{ background: f.weak, color: f.accent }}>{f.icon}</div>
            <div className="l">{f.label}</div>
            <div className="v">{compactNum(f.v)}</div>
            <div className="d flat">
              {f.n} {f.type}{f.n === 1 ? "" : "s"} · view details →
            </div>
          </button>
        ))}
      </div>

      <div className="sectitle"><span className="dot" />Top performers<span className="s">best of the selected period</span></div>
      <div className="grid g2">
        {[["🥇 Best Reel — this period", bestReel], ["🥇 Best Carousel — this period", bestCarousel]].map(
          ([label, post]) => (
            <div className="spot2" key={label as string}>
              <div className="wt">{label as string}</div>
              {post ? (
                <>
                  <div className="tt">{(post as Post).title}</div>
                  <span className="tag">{pillarName((post as Post).pillar_id)}</span>
                  <div className="st" style={{ marginTop: 10 }}>
                    <span>Score <b>{formatScore(post as Post)}</b></span>
                    <span>Views <b>{compactNum((post as Post).views)}</b></span>
                    <span>Saves <b>{compactNum((post as Post).saves)}</b></span>
                  </div>
                </>
              ) : (
                <div className="tt" style={{ color: "var(--muted)", fontWeight: 500, fontSize: 13 }}>
                  No published {(label as string).includes("Reel") ? "reels" : "carousels"} in this period yet.
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card pad">
          <div className="sectitle" style={{ margin: "0 0 6px" }}><span className="dot" />Views by Pillar</div>
          {byPillar.length ? (
            <div className="barchart">
              {byPillar.map((r) => (
                <div className="col" key={r.name}>
                  <div className="bwrap"><div className="b" style={{ height: `${(r.views / maxPillar) * 100}%` }} /></div>
                  <div className="lbl">{r.name}</div>
                </div>
              ))}
            </div>
          ) : <EmptyChart />}
        </div>
        <div className="card pad">
          <div className="sectitle" style={{ margin: "0 0 6px" }}><span className="dot" />Views by Audience Avatar</div>
          {byAvatar.length ? (
            <div className="barchart">
              {byAvatar.map((r) => (
                <div className="col" key={r.name}>
                  <div className="bwrap"><div className="b" style={{ height: `${(r.views / maxAvatar) * 100}%`, background: "linear-gradient(180deg,var(--indigo),#8b5cf6)" }} /></div>
                  <div className="lbl">{r.name}</div>
                </div>
              ))}
            </div>
          ) : <EmptyChart />}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card pad">
          <div className="sectitle" style={{ margin: "0 0 6px" }}><span className="dot" />Content Mix<span className="s">reels vs carousels</span></div>
          {mixTotal ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 26, height: 180 }}>
              <svg width="150" height="150" viewBox="0 0 42 42">
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--accent)" strokeWidth="7" strokeDasharray={`${reelPct} ${100 - reelPct}`} strokeDashoffset="25" />
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--indigo)" strokeWidth="7" strokeDasharray={`${100 - reelPct} ${reelPct}`} strokeDashoffset={`${-(75 - reelPct)}`} />
              </svg>
              <div style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 8 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "var(--accent)", marginRight: 7 }} />Reels <b>{reelPct}%</b></div>
                <div><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "var(--indigo)", marginRight: 7 }} />Carousels <b>{100 - reelPct}%</b></div>
              </div>
            </div>
          ) : <EmptyChart />}
        </div>
        <div className="card pad">
          <div className="sectitle" style={{ margin: "0 0 6px" }}><span className="dot" />Engagement<span className="s">likes · comments · shares · saves</span></div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 180, fontSize: 13, color: "var(--muted)" }}>
            {eng > 0 ? (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 32, fontWeight: 800, color: "var(--text)" }}>{compactNum(eng)}</div>
                total interactions across {scopedCount.length} post{scopedCount.length === 1 ? "" : "s"}
              </div>
            ) : <EmptyChart />}
          </div>
        </div>
      </div>

      <div className="demo-note" style={{ marginTop: 18 }}>
        ↪ KPIs, best performers, pillar/avatar &amp; content mix — computed live from your published posts for the selected date range.
      </div>
    </section>
  );
}

function EmptyChart() {
  return (
    <div style={{ height: 180, display: "grid", placeItems: "center", color: "var(--faint)", fontSize: 13 }}>
      No published data in this range yet.
    </div>
  );
}
