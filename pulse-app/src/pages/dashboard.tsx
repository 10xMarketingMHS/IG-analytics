import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import type { Post, Platform, Account } from "@/lib/types";

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

  // Analytics count Published posts only (PRD FR-N8).
  const published = useMemo(
    () => (posts ?? []).filter((p) => p.status === "published"),
    [posts],
  );
  const scoped = useMemo(
    () => published.filter((p) => inRange(p.date, bounds.from, bounds.to)),
    [published, bounds.from, bounds.to],
  );

  // Per-platform post/view totals for the cards (same channel scope + range).
  const platformSummary = useMemo(() => {
    const m = new Map<string, { posts: number; views: number }>();
    for (const p of allPosts ?? []) {
      if (p.status !== "published" || !inRange(p.date, bounds.from, bounds.to)) continue;
      const key = p.platform_id ?? "";
      const cur = m.get(key) ?? { posts: 0, views: 0 };
      cur.posts += 1;
      cur.views += p.views;
      m.set(key, cur);
    }
    return m;
  }, [allPosts, bounds.from, bounds.to]);

  const sum = (arr: Post[], f: (p: Post) => number) => arr.reduce((a, p) => a + f(p), 0);
  const views = sum(scoped, (p) => p.views);
  const reach = sum(scoped, (p) => p.reach);
  const eng = sum(scoped, engagementOf);
  const engRate = reach ? ((eng / reach) * 100).toFixed(1) + "%" : "—";

  // Period-over-period growth for Views & Reach (PRD §10.4).
  let viewsDelta: number | null = null;
  let reachDelta: number | null = null;
  if (bounds.from && bounds.to) {
    const prev = previousRange(bounds.from, bounds.to);
    const prevScoped = published.filter((p) => inRange(p.date, prev.from, prev.to));
    const pv = sum(prevScoped, (p) => p.views);
    const pr = sum(prevScoped, (p) => p.reach);
    viewsDelta = pv ? Math.round(((views - pv) / pv) * 100) : null;
    reachDelta = pr ? Math.round(((reach - pr) / pr) * 100) : null;
  }

  const byGroup = (getId: (p: Post) => string, list?: { id: string; name: string }[]) => {
    const totals = new Map<string, number>();
    for (const p of scoped) totals.set(getId(p), (totals.get(getId(p)) ?? 0) + p.views);
    const rows = (list ?? []).map((x) => ({ name: x.name, views: totals.get(x.id) ?? 0 }));
    return rows.filter((r) => r.views > 0).sort((a, b) => b.views - a.views).slice(0, 8);
  };
  const byPillar = byGroup((p) => p.pillar_id, taxonomy?.pillars);
  const byAvatar = byGroup((p) => p.avatar_id, taxonomy?.avatars);
  const maxPillar = Math.max(1, ...byPillar.map((r) => r.views));
  const maxAvatar = Math.max(1, ...byAvatar.map((r) => r.views));

  const reelPosts = scoped.filter((p) => p.post_type === "reel");
  const carouselPosts = scoped.filter((p) => p.post_type === "carousel");
  const reels = reelPosts.length;
  const carousels = carouselPosts.length;
  const reelViews = sum(reelPosts, (p) => p.views);
  const carouselViews = sum(carouselPosts, (p) => p.views);
  const mixTotal = reels + carousels;
  const reelPct = mixTotal ? Math.round((reels / mixTotal) * 100) : 0;

  // Best performer = highest Performance Score (PRD scoring spec).
  const best = (type: "reel" | "carousel") =>
    scoped
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

  const kpis: [string, string, string, string | null][] = [
    ["📝", "Total Posts", String(scoped.length), null],
    ["👁️", "Total Views", compactNum(views), viewsDelta == null ? null : (viewsDelta >= 0 ? "up" : "down")],
    ["📡", "Accounts Reached", compactNum(reach), reachDelta == null ? null : (reachDelta >= 0 ? "up" : "down")],
    ["⚡", "Engagement Rate", engRate, "flat"],
  ];
  const deltaText = (kind: string | null, d: number | null) =>
    kind === "up" || kind === "down"
      ? `${d != null && d >= 0 ? "▲" : "▼"} ${d != null ? Math.abs(d) + "% vs prev" : ""}`
      : " ";

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
          Showing <b style={{ color: "var(--text)" }}>{rangeLabel}</b> · {scoped.length} post{scoped.length === 1 ? "" : "s"}
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
        <span className="dot" />Platforms<span className="s">click a platform to see its analytics</span>
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
        <span className="s">{rangeLabel} · {scoped.length} post{scoped.length === 1 ? "" : "s"}</span>
      </div>

      <div className="grid g4">
        {kpis.map(([ic, l, v, kind], i) => (
          <div className="card kpi" key={l}>
            <div className="ic">{ic}</div>
            <div className="l">{l}</div>
            <div className="v">{v}</div>
            <div className={"d " + (kind ?? "flat")}>
              {deltaText(kind, i === 1 ? viewsDelta : i === 2 ? reachDelta : null)}
            </div>
          </div>
        ))}
      </div>

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
                total interactions across {scoped.length} post{scoped.length === 1 ? "" : "s"}
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
