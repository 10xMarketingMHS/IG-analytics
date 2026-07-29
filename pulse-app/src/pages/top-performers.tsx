import { useMemo, useState } from "react";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import { rangeFor, inRange, compactNum, type RangeKey } from "@/lib/date-range";
import { performanceScore, formatScore } from "@/lib/score";
import type { Post, Platform } from "@/lib/types";

const PLATFORM_ICON: Record<string, string> = { instagram: "📸", facebook: "👍", youtube: "▶️" };
const PLATFORM_GRAD: Record<string, string> = {
  instagram: "linear-gradient(135deg,#f9737d,#c13584,#833ab4)",
  facebook: "linear-gradient(135deg,#1877f2,#0a5bd3)",
  youtube: "linear-gradient(135deg,#ff4e45,#c4302b)",
};
// Post types we spotlight a "best of" for. Reel + Carousel today; a platform
// that only has one type simply shows that one.
const TYPE_LABEL: Record<string, string> = { reel: "Reel", carousel: "Carousel" };

const RANGES: [RangeKey, string][] = [
  ["thismonth", "This month"], ["last30", "Last 30 days"], ["thisyear", "This year"], ["all", "All time"],
];

type P = Post & { channel_name?: string };
const engOf = (p: Post) => p.likes + p.comments + p.shares + p.saves;
const engRate = (p: Post) => (p.reach ? (engOf(p) / p.reach) * 100 : 0);
// Highest-first winner of a list by some measure (null if the list is empty).
function top<T>(list: T[], by: (x: T) => number): T | null {
  return list.length ? [...list].sort((a, b) => by(b) - by(a))[0] : null;
}

export function TopPerformersPage() {
  const { workspaces } = useWorkspaces();
  const [channel, setChannel] = useState("all");
  const [range, setRange] = useState<RangeKey>("all");
  const { data: postData, loading } = useResource<{ posts: P[] }>(`/posts?channel=${channel}`);
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");

  const bounds = rangeFor(range);
  const published = useMemo(
    () => (postData?.posts ?? []).filter((p) => p.status === "published" && inRange(p.date, bounds.from, bounds.to)),
    [postData, bounds.from, bounds.to],
  );

  // Group published posts by platform; only platforms with data get a section.
  const sections = useMemo(() => {
    const platforms = platData?.platforms ?? [];
    return platforms
      .map((pf) => ({ platform: pf, posts: published.filter((p) => p.platform_id === pf.id) }))
      .filter((s) => s.posts.length > 0)
      .sort((a, b) => b.posts.length - a.posts.length);
  }, [platData, published]);

  const noData = !loading && published.length === 0;

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
          {RANGES.map(([k, label]) => (
            <button key={k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{label}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="card pad hint">Crunching your best content…</div>
      ) : noData ? (
        <div className="card pad home-empty">
          No published posts with metrics in this range yet. Sync a connected account or log some metrics, then come back.
        </div>
      ) : (
        sections.map(({ platform, posts }) => {
          const types = Array.from(new Set(posts.map((p) => p.post_type))).filter(Boolean);
          const rankedByScore = [...posts].sort((a, b) => performanceScore(b) - performanceScore(a));
          const leaders: { label: string; icon: string; post: P | null; val: (p: Post) => string }[] = [
            { label: "Most Views", icon: "👁️", post: top(posts, (p) => p.views), val: (p) => compactNum(p.views) },
            { label: "Most Reach", icon: "📡", post: top(posts, (p) => p.reach), val: (p) => compactNum(p.reach) },
            { label: "Most Saves", icon: "🔖", post: top(posts, (p) => p.saves), val: (p) => compactNum(p.saves) },
            { label: "Most Shares", icon: "🔁", post: top(posts, (p) => p.shares), val: (p) => compactNum(p.shares) },
            { label: "Best Engagement", icon: "⚡", post: top(posts, engRate), val: (p) => engRate(p).toFixed(1) + "%" },
          ];

          return (
            <div key={platform.id} className="tp-section">
              <div className="tp-head">
                <span className="tp-logo" style={{ background: PLATFORM_GRAD[platform.key] ?? "var(--grad)" }}>
                  {PLATFORM_ICON[platform.key] ?? "📱"}
                </span>
                <h3>{platform.name}</h3>
                <span className="tp-count">{posts.length} published post{posts.length === 1 ? "" : "s"}</span>
              </div>

              {/* Best of each content type */}
              <div className="grid g2">
                {types.map((t) => {
                  const best = top(posts.filter((p) => p.post_type === t), performanceScore);
                  const label = TYPE_LABEL[t] ?? t;
                  return (
                    <div className="spot2" key={t}>
                      <div className="wt">🥇 Best {label}</div>
                      {best ? (
                        <>
                          <div className="tt">{best.title}</div>
                          {best.channel_name && <span className="tag">{best.channel_name}</span>}
                          <div className="st" style={{ marginTop: 10 }}>
                            <span>Score <b>{formatScore(best)}</b></span>
                            <span>Views <b>{compactNum(best.views)}</b></span>
                            <span>Eng <b>{engRate(best).toFixed(1)}%</b></span>
                          </div>
                        </>
                      ) : (
                        <div className="tt tp-none">No {label.toLowerCase()}s in this range.</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Category leaders */}
              <div className="tp-leaders">
                {leaders.map((l) => (
                  <div className="tp-leader" key={l.label}>
                    <div className="tp-leader-top"><span className="tp-lic">{l.icon}</span>{l.label}</div>
                    {l.post ? (
                      <>
                        <div className="tp-leader-val">{l.val(l.post)}</div>
                        <div className="tp-leader-title" title={l.post.title}>{l.post.title}</div>
                      </>
                    ) : <div className="tp-leader-val muted">—</div>}
                  </div>
                ))}
              </div>

              {/* Ranked top 5 by Performance Score */}
              <div className="tp-rankhead">Top posts by Performance Score</div>
              <div className="card tp-rank">
                {rankedByScore.slice(0, 5).map((p, i) => (
                  <div className="tp-row" key={p.id}>
                    <span className={"tp-rank-n r" + (i + 1)}>{i + 1}</span>
                    <div className="tp-row-main">
                      <div className="tp-row-title" title={p.title}>{p.title}</div>
                      <div className="tp-row-meta">
                        <span className="tp-type">{TYPE_LABEL[p.post_type] ?? p.post_type}</span>
                        {p.channel_name && <span>· {p.channel_name}</span>}
                      </div>
                    </div>
                    <div className="tp-row-stats">
                      <span>👁️ {compactNum(p.views)}</span>
                      <span>🔖 {compactNum(p.saves)}</span>
                      <span className="tp-score">★ {formatScore(p)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}

      {!noData && !loading && (
        <div className="demo-note" style={{ marginTop: 18 }}>
          ↪ Best content is ranked by <b>Performance Score</b> (view/like/comment/share/save rates over reach), computed
          separately per platform. Facebook &amp; YouTube appear here automatically once they have published posts.
        </div>
      )}
    </section>
  );
}
