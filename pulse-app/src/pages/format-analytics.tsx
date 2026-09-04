import { useMemo } from "react";
import { Loader } from "@/components/loader";
import { useNavigate, useParams } from "react-router-dom";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { usePosts } from "@/lib/use-posts";
import { compactNum } from "@/lib/date-range";
import { performanceScore, formatScore } from "@/lib/score";
import type { Post } from "@/lib/types";

type FormatType = "reel" | "carousel";

export function FormatAnalyticsPage() {
  const { type } = useParams<{ type: string }>();
  const format: FormatType = type === "carousel" ? "carousel" : "reel";
  const label = format === "carousel" ? "Carousel" : "Reel";

  const { taxonomy } = useTaxonomy();
  const navigate = useNavigate();
  const { posts } = usePosts();

  // Analytics count Published posts only (PRD FR-N8).
  const set = useMemo(
    () => (posts ?? []).filter((p) => p.status === "published" && p.post_type === format),
    [posts, format],
  );

  const sum = (f: (p: Post) => number) => set.reduce((a, p) => a + f(p), 0);
  const totals = {
    views: sum((p) => p.views),
    likes: sum((p) => p.likes),
    comments: sum((p) => p.comments),
    shares: sum((p) => p.shares),
    saves: sum((p) => p.saves),
    reach: sum((p) => p.reach),
  };
  const engagement = totals.likes + totals.comments + totals.shares + totals.saves;
  const engRate = totals.reach ? ((engagement / totals.reach) * 100).toFixed(1) + "%" : "—";
  const n = set.length;
  const avg = (v: number) => (n ? Math.round(v / n) : 0);

  const pillarName = (id: string) => taxonomy?.pillars.find((p) => p.id === id)?.name ?? "—";
  const avatarName = (id: string) => taxonomy?.avatars.find((a) => a.id === id)?.name ?? "—";

  // Per-pillar views breakdown.
  const byPillar = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of set) m.set(p.pillar_id, (m.get(p.pillar_id) ?? 0) + p.views);
    return (taxonomy?.pillars ?? [])
      .map((x) => ({ name: x.name, views: m.get(x.id) ?? 0 }))
      .filter((r) => r.views > 0)
      .sort((a, b) => b.views - a.views);
  }, [set, taxonomy]);
  const maxPillar = Math.max(1, ...byPillar.map((r) => r.views));

  const primaryKpis: [string, string, string][] = [
    ["🖼️", `Total ${label}s`, String(n)],
    ["👁️", "Total Views", compactNum(totals.views)],
    ["📡", "Accounts Reached", compactNum(totals.reach)],
    ["⚡", "Engagement Rate", engRate],
  ];
  const engagementKpis: [string, string, number][] = [
    ["❤️", "Likes", totals.likes],
    ["💬", "Comments", totals.comments],
    ["🔁", "Shares", totals.shares],
    ["🔖", "Saves", totals.saves],
  ];

  return (
    <section className="screen">
      <button className="btn" style={{ marginBottom: 16 }} onClick={() => navigate("/dashboard")}>
        ← Back to Dashboard
      </button>

      <div className="sectitle" style={{ marginTop: 0 }}>
        <span className="dot" />{label} performance
        <span className="s">all published {label.toLowerCase()} posts · all time</span>
      </div>

      {posts === null ? (
        <Loader label="Loading…" />
      ) : n === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          No published {label.toLowerCase()} posts yet. Publish some {label.toLowerCase()}s and log their
          metrics to see this breakdown.
        </div>
      ) : (
        <>
          <div className="grid g4">
            {primaryKpis.map(([ic, l, v]) => (
              <div className="card kpi" key={l}>
                <div className="ic">{ic}</div>
                <div className="l">{l}</div>
                <div className="v">{v}</div>
                <div className="d flat">&nbsp;</div>
              </div>
            ))}
          </div>

          <div className="sectitle"><span className="dot" />Total engagement<span className="s">summed across all {label.toLowerCase()}s</span></div>
          <div className="grid g4">
            {engagementKpis.map(([ic, l, v]) => (
              <div className="card kpi" key={l}>
                <div className="ic" style={{ background: "var(--indigo-weak)", color: "var(--indigo)" }}>{ic}</div>
                <div className="l">{l}</div>
                <div className="v">{compactNum(v)}</div>
                <div className="d flat">avg {compactNum(avg(v))}/post</div>
              </div>
            ))}
          </div>

          <div className="grid g2" style={{ marginTop: 16 }}>
            <div className="card pad">
              <div className="sectitle" style={{ margin: "0 0 6px" }}><span className="dot" />Averages per {label.toLowerCase()}</div>
              <div style={{ marginTop: 8 }}>
                {[
                  ["Views", avg(totals.views)],
                  ["Reach", avg(totals.reach)],
                  ["Likes", avg(totals.likes)],
                  ["Comments", avg(totals.comments)],
                  ["Shares", avg(totals.shares)],
                  ["Saves", avg(totals.saves)],
                ].map(([nm, v]) => (
                  <div className="weightrow" key={nm as string}>
                    <span className="nm">{nm}</span>
                    <span className="bar"><i style={{ width: `${Math.min(100, (Number(v) / Math.max(1, avg(totals.views))) * 100)}%` }} /></span>
                    <span className="wv">{compactNum(Number(v))}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card pad">
              <div className="sectitle" style={{ margin: "0 0 6px" }}><span className="dot" />Views by pillar</div>
              <div className="barchart">
                {byPillar.map((r) => (
                  <div className="col" key={r.name}>
                    <div className="bwrap"><div className="b" style={{ height: `${(r.views / maxPillar) * 100}%` }} /></div>
                    <div className="lbl">{r.name}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="sectitle"><span className="dot" />All {label.toLowerCase()} posts<span className="s">{n} published</span></div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Title</th><th>Pillar</th><th>Avatar</th>
                  <th className="num">Views</th><th className="num">Likes</th>
                  <th className="num">Comments</th><th className="num">Shares</th>
                  <th className="num">Saves</th><th className="num">Reach</th>
                  <th className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {[...set].sort((a, b) => performanceScore(b) - performanceScore(a)).map((p) => (
                  <tr key={p.id}>
                    <td>{p.date}</td>
                    <td><b style={{ fontWeight: 650 }}>{p.title}</b></td>
                    <td><span className="tag">{pillarName(p.pillar_id)}</span></td>
                    <td><span className="tag av">{avatarName(p.avatar_id)}</span></td>
                    <td className="num">{p.views.toLocaleString()}</td>
                    <td className="num">{p.likes.toLocaleString()}</td>
                    <td className="num">{p.comments.toLocaleString()}</td>
                    <td className="num">{p.shares.toLocaleString()}</td>
                    <td className="num">{p.saves.toLocaleString()}</td>
                    <td className="num">{p.reach.toLocaleString()}</td>
                    <td className="num"><b>{formatScore(p)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
