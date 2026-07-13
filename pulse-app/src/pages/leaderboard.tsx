import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useEditors } from "@/lib/use-editors";
import { usePosts } from "@/lib/use-posts";
import { rangeFor, inRange, compactNum } from "@/lib/date-range";
import type { Post, Editor } from "@/lib/types";

type Period = "month" | "all";

type Row = {
  editor: Editor;
  reels: number;
  carousels: number;
  views: number;
  points: number;
};

const AV_GRADIENTS = [
  "linear-gradient(135deg,#6366f1,#8b5cf6)",
  "linear-gradient(135deg,#0d9488,#0ea5e9)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#10b981,#3b82f6)",
  "linear-gradient(135deg,#f43f5e,#f59e0b)",
];
function gradFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_GRADIENTS[h % AV_GRADIENTS.length];
}

function Avatar({ editor }: { editor: Editor }) {
  if (editor.image_url) {
    return <img className="lb-ava" src={editor.image_url} alt={editor.name} />;
  }
  return (
    <div className="lb-ava" style={{ background: gradFor(editor.name) }}>
      {editor.name.charAt(0).toUpperCase()}
    </div>
  );
}

// Performance points: weighted engagement across the editor's reels &
// carousels — comments/shares/saves count more (mirrors the PRD scoring
// emphasis on the strongest quality signals).
function pointsOf(p: Post) {
  return p.likes + 2 * p.comments + 3 * p.shares + 3 * p.saves;
}

const MEDAL_VARIANT = ["gold", "silver", "bronze"] as const;
const LAUREL_COLOR: Record<string, string> = {
  gold: "#f5c451",
  silver: "#cbd5e1",
  bronze: "#d98a4a",
};

function Laurel({ rank, variant }: { rank: number; variant: "gold" | "silver" | "bronze" }) {
  const color = LAUREL_COLOR[variant];
  const N = 6;
  const leaves = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const y = 42 - t * 30;
    const xl = 20 - t * 8;
    const xr = 52 + t * 8;
    const ang = 18 + t * 62;
    leaves.push(
      <ellipse key={"l" + i} cx={xl} cy={y} rx="5.4" ry="2.7" fill={color} opacity={0.92} transform={`rotate(${-ang} ${xl} ${y})`} />,
      <ellipse key={"r" + i} cx={xr} cy={y} rx="5.4" ry="2.7" fill={color} opacity={0.92} transform={`rotate(${ang} ${xr} ${y})`} />,
    );
  }
  return (
    <svg viewBox="0 0 72 52" width="58" height="42" aria-hidden>
      {leaves}
      <text x="36" y="34" textAnchor="middle" fontSize="21" fontWeight="800" fill={color}>{rank}</text>
    </svg>
  );
}

export function LeaderboardPage() {
  const { editors } = useEditors();
  const { posts } = usePosts();
  const [period, setPeriod] = useState<Period>("month");

  const rows = useMemo<Row[]>(() => {
    if (!editors || !posts) return [];
    const bounds = period === "month" ? rangeFor("thismonth") : { from: null, to: null };
    // Analytics count published posts only (PRD FR-N8).
    const scoped = posts.filter(
      (p) => p.status === "published" && inRange(p.date, bounds.from, bounds.to),
    );
    return editors
      .map((editor) => {
        const own = scoped.filter((p) => p.editor_id === editor.id);
        return {
          editor,
          reels: own.filter((p) => p.post_type === "reel").length,
          carousels: own.filter((p) => p.post_type === "carousel").length,
          views: own.reduce((a, p) => a + p.views, 0),
          points: own.reduce((a, p) => a + pointsOf(p), 0),
        };
      })
      .sort((a, b) => b.points - a.points);
  }, [editors, posts, period]);

  const ranked = rows.filter((r) => r.reels + r.carousels > 0);
  const unranked = rows.filter((r) => r.reels + r.carousels === 0);

  return (
    <section className="screen">
      <div className="lb-hero">
        <div className="trophy">🏆</div>
        <div className="htext">
          <h2>Editor Leaderboard</h2>
          <p>
            Compete on craft — editors climb the ranking by the performance of the{" "}
            <b>Reels &amp; Carousels</b> they've edited. Points are weighted engagement
            (comments, shares &amp; saves count most) across their published posts.
          </p>
        </div>
      </div>

      <div className="lb-layout">
        <div className="lb-main">
          <div className="lb-statbar">
            <h3>Statistics</h3>
            <div className="lb-toggle">
              <button className={period === "month" ? "on" : ""} onClick={() => setPeriod("month")}>This month</button>
              <button className={period === "all" ? "on" : ""} onClick={() => setPeriod("all")}>All time</button>
            </div>
          </div>

          {editors === null || posts === null ? (
            <div className="hint">Loading…</div>
          ) : editors.length === 0 ? (
            <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
              No editors yet. Add your editing team in{" "}
              <Link to="/settings" style={{ color: "var(--accent-ink)", fontWeight: 700 }}>Settings → Editors</Link>, then assign them to posts.
            </div>
          ) : (
            <>
              <div className="lb-head">
                <div>Position</div>
                <div>Editor</div>
                <div className="lb-hidesm">Reels · Carousels</div>
                <div className="lb-hidesm" style={{ textAlign: "right", paddingRight: 10 }}>Views</div>
                <div style={{ textAlign: "right", paddingRight: 22 }}>Points</div>
              </div>

              <div className="lb-list">
                {ranked.map((r, i) => (
                  <div key={r.editor.id} className={"lb-row " + (MEDAL_VARIANT[i] ?? "")}>
                    <div className="lb-rankcell">
                      {i < 3 ? <Laurel rank={i + 1} variant={MEDAL_VARIANT[i]} /> : <span className="lb-rnum">{i + 1}</span>}
                    </div>
                    <div className="lb-player">
                      <Avatar editor={r.editor} />
                      <div className="who">
                        <b>{r.editor.name}</b>
                        <small>{r.editor.designation || "Editor"}</small>
                      </div>
                    </div>
                    <div className="lb-cell lb-hidesm">
                      <div className="lb-rc">
                        <span>🎬 <b>{r.reels}</b></span>
                        <span>🖼️ <b>{r.carousels}</b></span>
                      </div>
                    </div>
                    <div className="lb-cell num lb-hidesm">{r.views.toLocaleString()}</div>
                    <div className="lb-points">{r.points.toLocaleString()}</div>
                  </div>
                ))}

                {unranked.map((r) => (
                  <div key={r.editor.id} className="lb-row" style={{ opacity: 0.55 }}>
                    <div className="lb-rankcell"><span className="lb-rnum">—</span></div>
                    <div className="lb-player">
                      <Avatar editor={r.editor} />
                      <div className="who">
                        <b>{r.editor.name}</b>
                        <small>{r.editor.designation || "Editor"}</small>
                      </div>
                    </div>
                    <div className="lb-cell lb-hidesm" style={{ gridColumn: "3 / span 3" }}>
                      No published posts {period === "month" ? "this month" : "yet"}
                    </div>
                  </div>
                ))}
              </div>

              {ranked.length === 0 && (
                <div className="hint" style={{ marginTop: 14 }}>
                  No editor has published posts {period === "month" ? "this month" : "yet"}. Assign editors to
                  published posts on the <Link to="/posts/new" style={{ color: "var(--accent-ink)", fontWeight: 700 }}>Add Post</Link> screen.
                </div>
              )}
            </>
          )}
        </div>

        <FeaturedChampion champion={ranked[0]} period={period} />
      </div>
    </section>
  );
}

function Rings() {
  return (
    <svg className="fx-rings" viewBox="0 0 300 320" preserveAspectRatio="xMidYMin slice" aria-hidden>
      <rect x="58" y="34" width="184" height="252" rx="38" fill="none" stroke="rgba(140,170,255,.22)" strokeWidth="1.5" />
      <rect x="34" y="12" width="232" height="288" rx="50" fill="none" stroke="rgba(140,170,255,.15)" strokeWidth="1.5" />
      <rect x="8" y="-12" width="284" height="330" rx="62" fill="none" stroke="rgba(140,170,255,.09)" strokeWidth="1.5" />
    </svg>
  );
}

function FeaturedChampion({ champion, period }: { champion?: Row; period: Period }) {
  if (!champion) {
    return (
      <aside className="lb-featured empty">
        No #1 {period === "month" ? "this month" : "yet"} — assign editors to published posts.
      </aside>
    );
  }
  const { editor } = champion;
  return (
    <aside className="lb-featured" key={editor.id}>
      <Rings />
      <div className="fx-cap">🏆 Top Editor · {period === "month" ? "This month" : "All time"}</div>
      <div className="fx-frame">
        <span className="fx-medal">🥇</span>
        {editor.image_url ? (
          <img className="fx-img" src={editor.image_url} alt={editor.name} />
        ) : (
          <div className="fx-initial">{editor.name.charAt(0).toUpperCase()}</div>
        )}
      </div>
      <div className="fx-name">{editor.name}</div>
      <div className="fx-role">{editor.designation || "Editor"}</div>
      <div className="fx-stats">
        <div className="fx-stat"><b>{champion.points.toLocaleString()}</b><span>Points</span></div>
        <div className="fx-stat"><b>{compactNum(champion.views)}</b><span>Views</span></div>
        <div className="fx-stat"><b>{champion.reels + champion.carousels}</b><span>Posts</span></div>
      </div>
    </aside>
  );
}
