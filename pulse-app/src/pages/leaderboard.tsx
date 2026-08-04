import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { useTasks } from "@/lib/use-tasks";
import { rangeFor, inRange, compactNum } from "@/lib/date-range";
import type { Post, Editor } from "@/lib/types";

type Period = "month" | "all";
type Tab = "social" | "house" | "path";

type Row = { editor: Editor; reels: number; carousels: number; views: number; points: number };
type HouseRow = { editor: Editor; assigned: number; completed: number; rate: number };

const AV_GRADIENTS = [
  "linear-gradient(135deg,#7c3aed,#a855f7)",
  "linear-gradient(135deg,#8b5cf6,#22d3ee)",
  "linear-gradient(135deg,#a855f7,#f472b6)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#6366f1,#22d3ee)",
  "linear-gradient(135deg,#f59e0b,#a855f7)",
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

// Weighted engagement across an editor's reels & carousels.
function pointsOf(p: Post) {
  return p.likes + 2 * p.comments + 3 * p.shares + 3 * p.saves;
}

// ---- Progress Path (rank-over-time bump chart, last 30 days) ----
const PATH_COLORS = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1", "#14b8a6", "#e11d48"];
const CP = 7; // checkpoints across the 30-day window
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ProgressPath({ editors, posts }: { editors: Editor[]; posts: Post[] }) {
  const N = editors.length;
  const series = useMemo(() => {
    const now = new Date();
    const day = 86400000;
    const windowStart = ymd(new Date(now.getTime() - 30 * day));
    const cps = Array.from({ length: CP }, (_, i) => new Date(now.getTime() - (CP - 1 - i) * (30 / (CP - 1)) * day));
    const cpYmd = cps.map(ymd);
    const pub = posts.filter((p) => p.status === "published" && p.editor_id && p.date >= windowStart);
    // Cumulative points per editor at each checkpoint, then rank (1 = best).
    const ranks = new Map<string, number[]>();
    const cumuAt = cpYmd.map((D) => {
      const m: Record<string, number> = {};
      for (const e of editors) m[e.id] = 0;
      for (const p of pub) if (p.date <= D) m[p.editor_id!] = (m[p.editor_id!] ?? 0) + pointsOf(p);
      return m;
    });
    for (let i = 0; i < CP; i++) {
      const m = cumuAt[i];
      [...editors].sort((a, b) => (m[b.id] - m[a.id]) || a.name.localeCompare(b.name)).forEach((e, idx) => {
        const arr = ranks.get(e.id) ?? [];
        arr[i] = idx + 1;
        ranks.set(e.id, arr);
      });
    }
    return { cps, ranks, finalCumu: cumuAt[CP - 1] };
  }, [editors, posts]);

  const rowH = 40, padTop = 30, padBot = 36, padLeft = 44, padRight = 190, W = 760;
  const H = padTop + N * rowH + padBot;
  const plotLeft = padLeft, plotRight = W - padRight;
  const yFor = (rank: number) => padTop + (rank - 0.5) * rowH;
  const xFor = (i: number) => plotLeft + (i / (CP - 1)) * (plotRight - plotLeft);
  const colorOf = (id: string) => PATH_COLORS[editors.findIndex((x) => x.id === id) % PATH_COLORS.length];

  return (
    <div className="pp-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="pp-svg" role="img" aria-label="Editor performance over the last 30 days">
        {Array.from({ length: N }, (_, r) => (
          <g key={r}>
            <line x1={plotLeft} y1={yFor(r + 1)} x2={plotRight} y2={yFor(r + 1)} className="pp-grid" />
            <text x={plotLeft - 16} y={yFor(r + 1) + 4} className="pp-rank" textAnchor="middle">{r + 1}</text>
          </g>
        ))}
        {series.cps.map((d, i) => (
          <text key={i} x={xFor(i)} y={H - 12} className="pp-date" textAnchor="middle">{`${MON[d.getMonth()]} ${d.getDate()}`}</text>
        ))}
        {editors.map((e) => {
          const r = series.ranks.get(e.id) ?? [];
          const pts = r.map((rk, i) => `${xFor(i)},${yFor(rk)}`).join(" ");
          const color = colorOf(e.id);
          return (
            <g key={e.id}>
              <polyline points={pts} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
              {r.map((rk, i) => <circle key={i} cx={xFor(i)} cy={yFor(rk)} r="2.6" fill={color} />)}
            </g>
          );
        })}
        {editors.map((e) => {
          const r = series.ranks.get(e.id) ?? [];
          const fr = r[CP - 1] ?? N;
          const cy = yFor(fr);
          const cx = plotRight + 26;
          const color = colorOf(e.id);
          return (
            <g key={e.id}>
              <line x1={plotRight} y1={cy} x2={cx - 14} y2={cy} stroke={color} strokeWidth="2.4" opacity="0.92" />
              <circle cx={cx} cy={cy} r="14" fill="var(--panel)" stroke={color} strokeWidth="2.5" />
              {e.image_url ? (
                <>
                  <clipPath id={`ppc-${e.id}`}><circle cx={cx} cy={cy} r="12.5" /></clipPath>
                  <image href={e.image_url} x={cx - 12.5} y={cy - 12.5} width="25" height="25" clipPath={`url(#ppc-${e.id})`} preserveAspectRatio="xMidYMid slice" />
                </>
              ) : (
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill={color}>{e.name.charAt(0).toUpperCase()}</text>
              )}
              <text x={cx + 24} y={cy - 1} className="pp-name">{e.name}</text>
              <text x={cx + 24} y={cy + 12} className="pp-pts">{(series.finalCumu[e.id] || 0).toLocaleString()} pts · #{fr}</text>
              <title>{`${e.name} — rank #${fr}, ${(series.finalCumu[e.id] || 0).toLocaleString()} pts`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const MEDAL_VARIANT = ["gold", "silver", "bronze"] as const;
const LAUREL_COLOR: Record<string, string> = { gold: "#f5c451", silver: "#cbd5e1", bronze: "#d98a4a" };

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
  // Social ranking spans every channel in the Media House.
  const { data: postData } = useResource<{ posts: Post[] }>("/posts?channel=all");
  const posts = postData?.posts ?? null;
  const { tasks } = useTasks();
  const [tab, setTab] = useState<Tab>("social");
  const [period, setPeriod] = useState<Period>("month");

  // ---- Social Media Leaders ----
  const socialRows = useMemo<Row[]>(() => {
    if (!editors || !posts) return [];
    const bounds = period === "month" ? rangeFor("thismonth") : { from: null, to: null };
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

  const socialRanked = socialRows.filter((r) => r.reels + r.carousels > 0);
  const socialUnranked = socialRows.filter((r) => r.reels + r.carousels === 0);

  // ---- Media House Leaders (task completion) ----
  const houseRows = useMemo<HouseRow[]>(() => {
    if (!editors || !tasks) return [];
    return editors
      .map((editor) => {
        const own = tasks.filter((t) => t.editor_id === editor.id);
        const completed = own.filter((t) => t.status === "done").length;
        const assigned = own.length;
        return { editor, assigned, completed, rate: assigned ? completed / assigned : 0 };
      })
      // Rank by completion rate, then by volume completed (fair tiebreak).
      .sort((a, b) => b.rate - a.rate || b.completed - a.completed);
  }, [editors, tasks]);

  const houseRanked = houseRows.filter((r) => r.assigned > 0);
  const houseUnranked = houseRows.filter((r) => r.assigned === 0);

  const loading = editors === null || posts === null;

  return (
    <section className="screen">
      <div className="lb-hero">
        <div className="trophy">🏆</div>
        <div className="htext">
          <h2>Media House Leaderboard</h2>
          <p>
            Two ways to lead. <b>Social Media Leaders</b> climb on the performance of the Reels &amp;
            Carousels they edit. <b>Media House Leaders</b> climb on getting their assigned tasks done.
          </p>
        </div>
      </div>

      <div className="lb-tabs">
        <button className={tab === "social" ? "on" : ""} onClick={() => setTab("social")}>
          🎬 Social Media Leaders
        </button>
        <button className={tab === "house" ? "on" : ""} onClick={() => setTab("house")}>
          🏆 Media House Leaders
        </button>
        <button className={tab === "path" ? "on" : ""} onClick={() => setTab("path")}>
          📈 Progress Path
        </button>
      </div>

      {loading ? (
        <div className="hint">Loading…</div>
      ) : editors.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          No team members yet. Add your team in{" "}
          <Link to="/settings" style={{ color: "var(--accent-ink)", fontWeight: 700 }}>Settings → Editors</Link>.
        </div>
      ) : tab === "social" ? (
        <div className="lb-layout">
          <div className="lb-main">
            <div className="lb-statbar">
              <h3>Content performance</h3>
              <div className="lb-toggle">
                <button className={period === "month" ? "on" : ""} onClick={() => setPeriod("month")}>This month</button>
                <button className={period === "all" ? "on" : ""} onClick={() => setPeriod("all")}>All time</button>
              </div>
            </div>

            <div className="lb-head">
              <div>Position</div>
              <div>Editor</div>
              <div className="lb-hidesm">Reels · Carousels</div>
              <div className="lb-hidesm" style={{ textAlign: "right", paddingRight: 10 }}>Views</div>
              <div style={{ textAlign: "right", paddingRight: 22 }}>Points</div>
            </div>
            <div className="lb-list">
              {socialRanked.map((r, i) => (
                <div key={r.editor.id} className={"lb-row " + (MEDAL_VARIANT[i] ?? "")}>
                  <div className="lb-rankcell">
                    {i < 3 ? <Laurel rank={i + 1} variant={MEDAL_VARIANT[i]} /> : <span className="lb-rnum">{i + 1}</span>}
                  </div>
                  <div className="lb-player">
                    <Avatar editor={r.editor} />
                    <div className="who"><b>{r.editor.name}</b><small>{r.editor.designation || "Editor"}</small></div>
                  </div>
                  <div className="lb-cell lb-hidesm"><div className="lb-rc"><span>🎬 <b>{r.reels}</b></span><span>🖼️ <b>{r.carousels}</b></span></div></div>
                  <div className="lb-cell num lb-hidesm">{r.views.toLocaleString()}</div>
                  <div className="lb-points">{r.points.toLocaleString()}</div>
                </div>
              ))}
              {socialUnranked.map((r) => (
                <div key={r.editor.id} className="lb-row" style={{ opacity: 0.55 }}>
                  <div className="lb-rankcell"><span className="lb-rnum">—</span></div>
                  <div className="lb-player">
                    <Avatar editor={r.editor} />
                    <div className="who"><b>{r.editor.name}</b><small>{r.editor.designation || "Editor"}</small></div>
                  </div>
                  <div className="lb-cell lb-hidesm" style={{ gridColumn: "3 / span 3" }}>
                    No published posts {period === "month" ? "this month" : "yet"}
                  </div>
                </div>
              ))}
            </div>
            {socialRanked.length === 0 && (
              <div className="hint" style={{ marginTop: 14 }}>
                No editor has published posts {period === "month" ? "this month" : "yet"}.
              </div>
            )}
          </div>
          <FeaturedSocial champion={socialRanked[0]} period={period} />
        </div>
      ) : tab === "path" ? (
        <div className="card pad">
          <div className="lb-statbar">
            <h3>Progress path · last 30 days</h3>
            <div className="hint" style={{ margin: 0 }}>Editors climb as their published Reels &amp; Carousels earn points</div>
          </div>
          {posts && posts.filter((p) => p.status === "published" && p.editor_id).length > 0 ? (
            <ProgressPath editors={editors} posts={posts} />
          ) : (
            <div className="hint" style={{ marginTop: 12 }}>
              No published posts with an assigned editor in the last 30 days yet — the path fills in as content ships.
            </div>
          )}
        </div>
      ) : (
        <div className="lb-layout">
          <div className="lb-main">
            <div className="lb-statbar">
              <h3>Work performance</h3>
              <div className="hint" style={{ margin: 0 }}>Ranked by task completion</div>
            </div>

            <div className="lb-head lb-head-house">
              <div>Position</div>
              <div>Team member</div>
              <div className="lb-hidesm" style={{ textAlign: "right", paddingRight: 24 }}>Done · Assigned</div>
              <div style={{ textAlign: "right", paddingRight: 22 }}>Completion</div>
            </div>
            <div className="lb-list">
              {houseRanked.map((r, i) => (
                <div key={r.editor.id} className={"lb-row lb-row-house " + (MEDAL_VARIANT[i] ?? "")}>
                  <div className="lb-rankcell">
                    {i < 3 ? <Laurel rank={i + 1} variant={MEDAL_VARIANT[i]} /> : <span className="lb-rnum">{i + 1}</span>}
                  </div>
                  <div className="lb-player">
                    <Avatar editor={r.editor} />
                    <div className="who"><b>{r.editor.name}</b><small>{r.editor.designation || "Editor"}</small></div>
                  </div>
                  <div className="lb-cell num lb-hidesm">{r.completed} · {r.assigned}</div>
                  <div className="lb-points">{Math.round(r.rate * 100)}%</div>
                </div>
              ))}
              {houseUnranked.map((r) => (
                <div key={r.editor.id} className="lb-row lb-row-house" style={{ opacity: 0.55 }}>
                  <div className="lb-rankcell"><span className="lb-rnum">—</span></div>
                  <div className="lb-player">
                    <Avatar editor={r.editor} />
                    <div className="who"><b>{r.editor.name}</b><small>{r.editor.designation || "Editor"}</small></div>
                  </div>
                  <div className="lb-cell lb-hidesm" style={{ gridColumn: "3 / span 2" }}>No tasks assigned yet</div>
                </div>
              ))}
            </div>
            {houseRanked.length === 0 && (
              <div className="hint" style={{ marginTop: 14 }}>
                No tasks completed yet. Assign tasks on the{" "}
                <Link to="/tasks" style={{ color: "var(--accent-ink)", fontWeight: 700 }}>Task Management</Link> board.
              </div>
            )}
          </div>
          <FeaturedHouse champion={houseRanked[0]} />
        </div>
      )}
    </section>
  );
}

function Rings() {
  return (
    <svg className="fx-rings" viewBox="0 0 300 320" preserveAspectRatio="xMidYMin slice" aria-hidden>
      <rect x="58" y="34" width="184" height="252" rx="38" fill="none" stroke="rgba(180,150,255,.22)" strokeWidth="1.5" />
      <rect x="34" y="12" width="232" height="288" rx="50" fill="none" stroke="rgba(180,150,255,.15)" strokeWidth="1.5" />
      <rect x="8" y="-12" width="284" height="330" rx="62" fill="none" stroke="rgba(180,150,255,.09)" strokeWidth="1.5" />
    </svg>
  );
}

function FeaturedFrame({ editor, medal }: { editor: Editor; medal: string }) {
  return (
    <div className="fx-frame">
      <span className="fx-medal">{medal}</span>
      {editor.image_url ? (
        <img className="fx-img" src={editor.image_url} alt={editor.name} />
      ) : (
        <div className="fx-initial">{editor.name.charAt(0).toUpperCase()}</div>
      )}
    </div>
  );
}

function FeaturedSocial({ champion, period }: { champion?: Row; period: Period }) {
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
      <FeaturedFrame editor={editor} medal="🥇" />
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

function FeaturedHouse({ champion }: { champion?: HouseRow }) {
  if (!champion) {
    return <aside className="lb-featured empty">No #1 yet — assign tasks to your team.</aside>;
  }
  const { editor } = champion;
  return (
    <aside className="lb-featured" key={editor.id}>
      <Rings />
      <div className="fx-cap">🏆 Top Performer · Work</div>
      <FeaturedFrame editor={editor} medal="🥇" />
      <div className="fx-name">{editor.name}</div>
      <div className="fx-role">{editor.designation || "Editor"}</div>
      <div className="fx-stats">
        <div className="fx-stat"><b>{Math.round(champion.rate * 100)}%</b><span>Completion</span></div>
        <div className="fx-stat"><b>{champion.completed}</b><span>Done</span></div>
        <div className="fx-stat"><b>{champion.assigned}</b><span>Assigned</span></div>
      </div>
    </aside>
  );
}
