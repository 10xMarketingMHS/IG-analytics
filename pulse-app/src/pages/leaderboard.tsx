import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Loader } from "@/components/loader";
import { Link } from "react-router-dom";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { ManagementPerformanceBoard } from "@/pages/management-performance";
import { useResource } from "@/lib/use-resource";
import { useTasks } from "@/lib/use-tasks";
import { rangeFor, inRange, compactNum } from "@/lib/date-range";
import { ymd, taskPoints, isScorableTask, countsInTaskScore } from "@/lib/task-points";
import { Avatar, ringColorOf } from "@/lib/editor-visuals";
import type { Post, Editor, Task } from "@/lib/types";

type Period = "month" | "all";
type Tab = "social" | "house" | "path" | "mp";

type Row = { editor: Editor; reels: number; carousels: number; views: number; points: number };
// One person on Media House Leaders (server/src/routes/leaderboard.js): the
// month's points, jobs completed, goal points, and the share of the goal
// reached, counted in jobs per type (null with no goal set).
type GoalType = { contentFormatId: string; name: string; icon: string | null; goal: number; done: number; covered?: number; points: number };
type HouseRow = { editor: Editor; points: number; completed: number; goal: number; goalPct: number | null; byType: GoalType[]; coveredJobs: number; leaveDays: number };
type HouseApiRow = { editorId: string; points: number; completed: number; goalPoints: number; goalPct: number | null; byType: GoalType[]; coveredJobs?: number; leaveDays?: number };

// Weighted engagement across an editor's reels & carousels.
function pointsOf(p: Post) {
  return p.likes + 2 * p.comments + 3 * p.shares + 3 * p.saves;
}

// ---- Progress Path (rank-over-time bump chart, per calendar month, daily) ----
type PathMode = "content" | "task";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function labelMonth(m: string) {
  const [y, mo] = m.split("-");
  return `${MON[Number(mo) - 1]} ${y}`;
}

// Months (YYYY-MM, ascending, capped at the current month) that hold data for
// the active mode. Content = published-post dates; Task = completion *or* due
// months, so a month with only pending/overdue work still shows editors falling
// behind. `date`/`due_date` arrive as raw YYYY-MM-DD (no TZ); `completed_at` is a
// timestamptz, so its calendar day is taken in local time (IST for this team),
// matching the rest of the chart's local date math.
function monthsForMode(mode: PathMode, posts: Post[], tasks: Task[]): string[] {
  const cur = ymd(new Date()).slice(0, 7);
  const s = new Set<string>();
  if (mode === "content") {
    for (const p of posts) if (p.status === "published" && p.editor_id) s.add(p.date.slice(0, 7));
  } else {
    for (const t of tasks) {
      if (!t.editor_id) continue;
      if (t.completed_at) s.add(ymd(new Date(t.completed_at)).slice(0, 7));
      if (t.due_date) s.add(t.due_date.slice(0, 7));
    }
  }
  return [...s].filter((m) => m <= cur).sort();
}

// Honours the OS "reduce motion" setting — when set, the replay is skipped and
// the chart paints its final state instantly.
function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

// Daily cumulative score + rank for one month. Fresh start: day 1 = 0 for every
// editor (ties broken alphabetically). Task mode uses the points formula (see
// taskPoints above) — timeliness-based, bounded to each task's own base value.
//
// The x-axis always spans the FULL calendar month (`axisDays`, 28-31 days); the
// drawn line/dots/avatars stop at `dataLen` — today for the in-progress month,
// the whole month for a completed past month. Future days render as bare ticks.
function buildSeries(mode: PathMode, month: string, editors: Editor[], posts: Post[], tasks: Task[]) {
  const [y, mo] = month.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const today = new Date();
  const isCurrent = ymd(today).slice(0, 7) === month;
  const dataLen = isCurrent ? Math.min(today.getDate(), daysInMonth) : daysInMonth;
  const axisDays = Array.from({ length: daysInMonth }, (_, i) => new Date(y, mo - 1, i + 1));
  const dayKeys = axisDays.map(ymd);

  // Point-scoring events within the month, each landing on a specific day.
  const events: { e: string; day: string; pts: number }[] = [];
  if (mode === "content") {
    for (const p of posts) {
      if (p.status !== "published" || !p.editor_id) continue;
      if (p.date.slice(0, 7) !== month) continue;
      events.push({ e: p.editor_id, day: p.date.slice(0, 10), pts: pointsOf(p) });
    }
  } else {
    for (const t of tasks) {
      if (!t.editor_id || !t.completed_at || !isScorableTask(t)) continue;
      const comp = ymd(new Date(t.completed_at)); // local calendar day of completion
      if (comp.slice(0, 7) !== month) continue;
      events.push({ e: t.editor_id, day: comp, pts: taskPoints(t) });
    }
  }

  // Cumulative score per editor at the close of each DRAWN day, then rank (1 = best).
  const ranks = new Map<string, number[]>();
  let finalScore: Record<string, number> = {};
  for (let i = 0; i < dataLen; i++) {
    const D = dayKeys[i];
    const m: Record<string, number> = {};
    for (const e of editors) m[e.id] = 0;
    for (const ev of events) if (ev.day <= D && m[ev.e] !== undefined) m[ev.e] += ev.pts;
    [...editors].sort((a, b) => (m[b.id] - m[a.id]) || a.name.localeCompare(b.name)).forEach((e, idx) => {
      const arr = ranks.get(e.id) ?? [];
      arr[i] = idx + 1;
      ranks.set(e.id, arr);
    });
    if (i === dataLen - 1) finalScore = m;
  }
  return { axisDays, dataLen, ranks, finalScore };
}

const EASE_DUR = 1000; // ms — fixed replay length, independent of the month's day count

function ProgressPath({ mode, month, editors, posts, tasks }: { mode: PathMode; month: string; editors: Editor[]; posts: Post[]; tasks: Task[] }) {
  const N = editors.length;
  const series = useMemo(() => buildSeries(mode, month, editors, posts, tasks), [mode, month, editors, posts, tasks]);
  const { axisDays, dataLen, ranks, finalScore } = series;
  const axisLen = axisDays.length;

  const reduceMotion = usePrefersReducedMotion();
  // Playhead in day-index space (0 → dataLen-1). Avatars and the revealed line
  // track it as it sweeps left→right on mount and on every mode/month change.
  const [progress, setProgress] = useState(Math.max(0, dataLen - 1));

  useLayoutEffect(() => {
    // Fresh sweep from day 1 on every trigger (mount, month change, mode change).
    // Keyed on primitives only (never on the animated value) so it can't loop.
    if (reduceMotion || dataLen <= 1) {
      setProgress(Math.max(0, dataLen - 1));
      return;
    }
    const target = dataLen - 1;
    let raf = 0;
    let startTs = 0;
    setProgress(0);
    const tick = (ts: number) => {
      if (!startTs) startTs = ts;
      const t = Math.min(1, (ts - startTs) / EASE_DUR);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic — quick start, gentle settle
      setProgress(eased * target);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, month, dataLen, N, reduceMotion]);

  const rowH = 40, padTop = 30, padBot = 36, padLeft = 44, padRight = 190, W = 760;
  const H = padTop + N * rowH + padBot;
  const plotLeft = padLeft, plotRight = W - padRight;
  const yFor = (rank: number) => padTop + (rank - 0.5) * rowH;
  // The x-axis always spans the full month; a degenerate 1-day axis pins to centre.
  const xFor = (i: number) => (axisLen <= 1 ? (plotLeft + plotRight) / 2 : plotLeft + (i / (axisLen - 1)) * (plotRight - plotLeft));
  const colorOf = (id: string) => ringColorOf(editors, id);

  const p = Math.max(0, Math.min(progress, Math.max(0, dataLen - 1)));
  const full = Math.floor(p);
  const frac = p - full;
  // Point along an editor's rank-path at the fractional playhead — y lerps across
  // day-to-day rank changes, so when two editors swap the avatars visibly cross.
  const tipOf = (rankArr: number[]) => {
    const r0 = rankArr[full] ?? N;
    const j = Math.min(full + 1, rankArr.length - 1);
    const r1 = rankArr[j] ?? r0;
    return {
      x: xFor(full) + (xFor(j) - xFor(full)) * frac,
      y: yFor(r0) + (yFor(r1) - yFor(r0)) * frac,
    };
  };

  return (
    <div className="pp-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="pp-svg" role="img" aria-label={`Editor ${mode === "task" ? "task-completion" : "content"} progress for ${labelMonth(month)}`}>
        {Array.from({ length: N }, (_, r) => (
          <g key={r}>
            <line x1={plotLeft} y1={yFor(r + 1)} x2={plotRight} y2={yFor(r + 1)} className="pp-grid" />
            <text x={plotLeft - 16} y={yFor(r + 1) + 4} className="pp-rank" textAnchor="middle">{r + 1}</text>
          </g>
        ))}
        {axisDays.map((d, i) => (
          <text key={i} x={xFor(i)} y={H - 12} className="pp-date" textAnchor="middle">{d.getDate()}</text>
        ))}
        {editors.map((e) => {
          const rankArr = ranks.get(e.id) ?? [];
          const color = colorOf(e.id);
          const last = Math.min(full, rankArr.length - 1);
          const pts: string[] = [];
          for (let i = 0; i <= last; i++) pts.push(`${xFor(i)},${yFor(rankArr[i] ?? N)}`);
          const tip = tipOf(rankArr);
          pts.push(`${tip.x},${tip.y}`);
          return (
            <g key={e.id}>
              <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
              {Array.from({ length: last + 1 }, (_, i) => (
                <circle key={i} cx={xFor(i)} cy={yFor(rankArr[i] ?? N)} r="2.4" fill={color} />
              ))}
            </g>
          );
        })}
        {editors.map((e) => {
          const rankArr = ranks.get(e.id) ?? [];
          const fr = rankArr[dataLen - 1] ?? N;
          const { x: cx, y: cy } = tipOf(rankArr);
          const color = colorOf(e.id);
          return (
            <g key={e.id}>
              <circle cx={cx} cy={cy} r="14" fill="var(--panel)" stroke={color} strokeWidth="2.5" />
              {e.image_url ? (
                <>
                  <clipPath id={`ppc-${e.id}`}><circle cx={cx} cy={cy} r="12.5" /></clipPath>
                  <image href={e.image_url} x={cx - 12.5} y={cy - 12.5} width="25" height="25" clipPath={`url(#ppc-${e.id})`} preserveAspectRatio="xMidYMid slice" />
                </>
              ) : (
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill={color}>{e.name.charAt(0).toUpperCase()}</text>
              )}
              <text x={cx + 22} y={cy - 1} className="pp-name">{e.name}</text>
              <text x={cx + 22} y={cy + 12} className="pp-pts">{(finalScore[e.id] || 0).toLocaleString()} pts · #{fr}</text>
              <title>{`${e.name} — rank #${fr}, ${(finalScore[e.id] || 0).toLocaleString()} pts`}</title>
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

// Media House Leaders Goal column: how much of the month's goal is reached,
// by the one goal rule (server/src/goal-score.js): jobs per content type, each
// up to 150% of its goal (cut for approved leave), plus covered work, weighed
// by the goal's points. It can pass 100%, up to 150% in all. Hover for each type's count.
// No goal set: says so.
function GoalCell({ goal, pct, byType, coveredJobs = 0, leaveDays = 0 }: { goal: number; pct: number | null; byType: GoalType[]; coveredJobs?: number; leaveDays?: number }) {
  if (pct == null || goal <= 0) return <span className="lb-goal-none">No goal set</span>;
  const title = [
    byType.map((g) => `${g.name}: ${g.done} of ${g.goal}${g.covered ? ` (${g.covered} covered)` : ""}`).join(" · "),
    coveredJobs > 0 ? `Covered for others: ${coveredJobs} job${coveredJobs === 1 ? "" : "s"}, counted on top` : "",
    leaveDays > 0 ? `Approved leave: ${leaveDays} day${leaveDays === 1 ? "" : "s"}, goal cut to match` : "",
  ].filter(Boolean).join("\n");
  return (
    <div className="lb-goal" title={title}>
      <div className="lb-goal-top">
        <span className="lb-goal-num">{Math.round(goal).toLocaleString()} pts</span>
        <span className={"lb-goal-pct" + (pct > 100 ? " over" : "")}>{Math.round(pct)}%</span>
      </div>
      <div className="lb-goal-bar"><div className="lb-goal-fill" style={{ width: `${Math.min(100, pct)}%` }} /></div>
      {(coveredJobs > 0 || leaveDays > 0) && (
        <div className="lb-goal-extra">
          {coveredJobs > 0 && <span>+{coveredJobs} covered</span>}
          {leaveDays > 0 && <span>{leaveDays}d leave</span>}
        </div>
      )}
    </div>
  );
}

export function LeaderboardPage() {
  const { editors } = useEditors();
  const { isAdmin } = useWorkspaces();
  // Social ranking spans every channel in the Media House.
  const { data: postData } = useResource<{ posts: Post[] }>("/posts?channel=all");
  // Editor rankings & the progress path are performance — exclude collab mirrors.
  const posts = postData?.posts?.filter((p) => !p.is_collab_mirror) ?? null;
  const { tasks } = useTasks();
  // Media House Leaders, worked out on the server for everyone alike
  // (server/src/routes/leaderboard.js): points, jobs and % of goal.
  const { data: houseData } = useResource<{ month: string; rows: HouseApiRow[] }>("/leaderboard/house");
  const [tab, setTab] = useState<Tab>("social");
  const [period, setPeriod] = useState<Period>("month");
  // Progress Path: content-points vs task-completion mode + selected month.
  // Progress Path is task-completion only — the old "Content points" mode was
  // removed, so this is locked to "task" (no toggle).
  const pathMode: PathMode = "task";
  const [pathMonth, setPathMonth] = useState<string>("");

  // ---- Social Media Leaders ----
  const socialRows = useMemo<Row[]>(() => {
    if (!editors || !posts) return [];
    const bounds = period === "month" ? rangeFor("thismonth") : { from: null, to: null };
    const scoped = posts.filter(
      (p) => p.status === "published" && inRange(p.date, bounds.from, bounds.to),
    );
    // People a Super Admin made exempt (Team › Roster) aren't on the leaderboard.
    return editors
      .filter((e) => e.active !== false && countsInTaskScore(e))
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

  // ---- Media House Leaders ----
  // This calendar month only, ranked by the share of each person's own goal
  // reached (jobs per type, each up to its goal), then points, then jobs; people
  // with no goal set come after, by points. The server orders them. People a
  // Super Admin switched out of the task score aren't on it.
  const houseRows = useMemo<HouseRow[]>(() => {
    if (!editors || !houseData) return [];
    const byId = new Map(editors.map((e) => [e.id, e]));
    return houseData.rows.flatMap((r) => {
      const editor = byId.get(r.editorId);
      return editor ? [{ editor, points: r.points, completed: r.completed, goal: r.goalPoints, goalPct: r.goalPct, byType: r.byType, coveredJobs: r.coveredJobs ?? 0, leaveDays: r.leaveDays ?? 0 }] : [];
    });
  }, [editors, houseData]);

  const houseRanked = houseRows.filter((r) => r.completed > 0);
  const houseUnranked = houseRows.filter((r) => r.completed === 0);
  const notScored = (editors ?? []).filter((e) => e.active && !countsInTaskScore(e));
  // Team-wide Goal total (pts) — sum across everyone with a goal this month.
  const houseTeamGoal = houseRows.reduce((s, r) => s + r.goal, 0);

  // ---- Progress Path: month options depend on the active mode ----
  const pathMonths = useMemo(
    () => monthsForMode(pathMode, posts ?? [], tasks ?? []),
    [pathMode, posts, tasks],
  );
  // Selected month, falling back to the latest available if the current pick has
  // no data in this mode. The fallback is derived (no effect) to avoid render
  // loops; monthFellBack drives the inline "showing X instead" note.
  const effectiveMonth = pathMonths.includes(pathMonth) ? pathMonth : (pathMonths[pathMonths.length - 1] ?? "");
  const monthFellBack = pathMonth !== "" && pathMonths.length > 0 && !pathMonths.includes(pathMonth);

  // Task mode only: editors with zero tasks assigned in the selected month are
  // dropped from the ranked lines entirely (a task counts if its due date OR its
  // completion falls in the month — the same rule that lists the month). Editors
  // WITH tasks but zero completed stay (flat at 0 = genuinely behind). Content
  // mode shows everyone but those exempt. People out of the task score never get
  // a line.
  const pathShown = useMemo(() => {
    if (!editors) return { shown: [] as Editor[], excluded: [] as Editor[] };
    if (pathMode !== "task" || !effectiveMonth) return { shown: editors.filter(countsInTaskScore), excluded: [] as Editor[] };
    const scored = editors.filter(countsInTaskScore);
    const assignedInMonth = (e: Editor) =>
      (tasks ?? []).some(
        (t) =>
          t.editor_id === e.id &&
          (((t.due_date && t.due_date.slice(0, 7) === effectiveMonth)) ||
            (t.completed_at && ymd(new Date(t.completed_at)).slice(0, 7) === effectiveMonth)),
      );
    const shown = scored.filter(assignedInMonth);
    return { shown, excluded: scored.filter((e) => !shown.includes(e)) };
  }, [editors, tasks, pathMode, effectiveMonth]);

  const loading = editors === null || posts === null;

  return (
    <section className="screen">
      <div className="lb-hero">
        <div className="trophy">🏆</div>
        <div className="htext">
          <p>
            Two ways to lead: <b>Social Media Leaders</b> climb on the performance of the Reels &amp;
            Carousels they edit, <b>Media House Leaders</b> climb on how much of their own monthly goal they finish.
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
        {isAdmin && (
          <button className={tab === "mp" ? "on" : ""} onClick={() => setTab("mp")}>
            📊 Management Performance
          </button>
        )}
      </div>

      {loading ? (
        <Loader label="Loading…" />
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

            <div className="lb-table-wrap">
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
            </div>
            {socialRanked.length === 0 && (
              <div className="hint" style={{ marginTop: 14 }}>
                No editor has published posts {period === "month" ? "this month" : "yet"}.
              </div>
            )}
            {notScored.length > 0 && (
              <div className="hint" style={{ marginTop: 10 }}>
                Not on the leaderboard (exempt): {notScored.map((e) => e.name).join(", ")}. A Super Admin can change this on Team › Roster.
              </div>
            )}
          </div>
          <FeaturedSocial champion={socialRanked[0]} period={period} />
        </div>
      ) : tab === "path" ? (
        <div className="card pad">
          <div className="lb-statbar">
            <h3>Progress path · {effectiveMonth ? labelMonth(effectiveMonth) : "—"}</h3>
            <div className="pp-controls">
              <select className="t pp-month" value={effectiveMonth} onChange={(e) => setPathMonth(e.target.value)} disabled={pathMonths.length === 0} aria-label="Select month">
                {pathMonths.length === 0 && <option value="">No data</option>}
                {pathMonths.map((m) => <option key={m} value={m}>{labelMonth(m)}</option>)}
              </select>
            </div>
          </div>
          <div className="hint" style={{ margin: "0 0 4px" }}>
            On time earns full points, 1 day late half, 2 days late none, 3+ days late costs the task's full points back. Days waiting for a reviewer don't count as late. Resets each month.
          </div>
          {monthFellBack && (
            <div className="pp-note">
              No task data for {labelMonth(pathMonth)} — showing {labelMonth(effectiveMonth)}.
            </div>
          )}
          {pathMonths.length === 0 ? (
            <div className="hint" style={{ marginTop: 12 }}>
              No assigned tasks with due dates yet — the path fills in as work gets scheduled and completed.
            </div>
          ) : pathShown.shown.length === 0 ? (
            <div className="hint" style={{ marginTop: 12 }}>
              No tasks assigned to anyone in {labelMonth(effectiveMonth)}.
            </div>
          ) : (
            <>
              <ProgressPath mode={pathMode} month={effectiveMonth} editors={pathShown.shown} posts={posts} tasks={tasks ?? []} />
              {pathShown.excluded.length > 0 && (
                <div className="hint" style={{ marginTop: 10 }}>
                  Not shown: {pathShown.excluded.map((e) => e.name).join(", ")} — no tasks assigned in {labelMonth(effectiveMonth)}.
                </div>
              )}
              {pathMode === "task" && notScored.length > 0 && (
                <div className="hint" style={{ marginTop: 6 }}>
                  Exempt from task scoring: {notScored.map((e) => e.name).join(", ")}.
                </div>
              )}
            </>
          )}
        </div>
      ) : tab === "mp" ? (
        <ManagementPerformanceBoard />
      ) : (
        <div className="lb-layout">
          <div className="lb-main">
            <div className="lb-statbar">
              <h3>Work performance</h3>
              <div className="hint" style={{ margin: 0 }}>Ranked by how much of their own goal each person reached: jobs per type, up to 150% each, plus work covered for others, up to 150% in all, with goals cut for approved leave. Then by points. Resets on the 1st.</div>
            </div>

            <div className="lb-table-wrap">
              <div className="lb-head lb-head-house">
                <div>Position</div>
                <div>Team member</div>
                <div className="lb-hidesm" style={{ textAlign: "right", paddingRight: 24 }}>Completed</div>
                <div className="lb-hidesm">Goal · progress</div>
                <div style={{ textAlign: "right", paddingRight: 22 }}>Points</div>
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
                    <div className="lb-cell num lb-hidesm">{r.completed}</div>
                    <div className="lb-cell lb-hidesm"><GoalCell goal={r.goal} pct={r.goalPct} byType={r.byType} coveredJobs={r.coveredJobs} leaveDays={r.leaveDays} /></div>
                    <div className="lb-points">{r.points.toFixed(1)}</div>
                  </div>
                ))}
                {houseUnranked.map((r) => (
                  <div key={r.editor.id} className="lb-row lb-row-house" style={{ opacity: 0.55 }}>
                    <div className="lb-rankcell"><span className="lb-rnum">—</span></div>
                    <div className="lb-player">
                      <Avatar editor={r.editor} />
                      <div className="who"><b>{r.editor.name}</b><small>{r.editor.designation || "Editor"}</small></div>
                    </div>
                    <div className="lb-cell lb-hidesm" style={{ gridColumn: "3 / span 3" }}>No tasks completed this month</div>
                  </div>
                ))}
              </div>
            </div>
            {notScored.length > 0 && (
              <div className="hint" style={{ marginTop: 10 }}>
                Exempt from task scoring: {notScored.map((e) => e.name).join(", ")}. A Super Admin can change this on Team › Roster.
              </div>
            )}
            {houseTeamGoal > 0 && (
              <div className="lb-teamgoal">Team Goal · <b>{Math.round(houseTeamGoal).toLocaleString()}</b> pts this month</div>
            )}
            {houseRanked.length === 0 && (
              <div className="hint" style={{ marginTop: 14 }}>
                No tasks completed this month yet. Assign tasks on the{" "}
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
        {champion.goalPct != null && <div className="fx-stat"><b>{Math.round(champion.goalPct)}%</b><span>Of goal</span></div>}
        <div className="fx-stat"><b>{champion.points.toFixed(1)}</b><span>Points</span></div>
        <div className="fx-stat"><b>{champion.completed}</b><span>Completed</span></div>
      </div>
    </aside>
  );
}
