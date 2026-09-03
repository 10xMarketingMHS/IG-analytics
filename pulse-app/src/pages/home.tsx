import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTasks } from "@/lib/use-tasks";
import { useAuth } from "@/lib/auth-context";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { rangeFor, inRange, compactNum } from "@/lib/date-range";
import { performanceScore, formatScore } from "@/lib/score";
import { ymd, myRankInRange } from "@/lib/task-points";
import { goalBreakdown, DISCIPLINE_CRITERIA, type Ratings } from "@/lib/goal-points";
import { api } from "@/lib/api";
import { TopPerformerTicker } from "@/components/top-performer-ticker";
import type { Post } from "@/lib/types";

function todayStr() {
  return ymd(new Date());
}
function greeting(now: Date) {
  const h = now.getHours();
  // Midnight-to-5am shouldn't say "Good morning" — nobody wants that at 1am.
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
// Monday-start of the current calendar week, as YYYY-MM-DD.
function weekStartStr() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return ymd(d);
}
function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
// A little extra flair once someone's actually on top of a board — a plain
// "#1" doesn't read as a win the way a medal does.
const RANK_BADGE: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

const STAGE_META: Record<string, { label: string; cls: string }> = {
  not_started: { label: "Not Started", cls: "ns" },
  in_progress: { label: "In Progress", cls: "ip" },
  in_review: { label: "In Review", cls: "ir" },
  pending: { label: "Pending", cls: "pd" },
  completed: { label: "Completed", cls: "cp" },
};

export function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { tasks } = useTasks();
  const { editors } = useEditors();
  const { data: postData } = useResource<{ posts: (Post & { channel_name?: string })[] }>("/posts?channel=all");
  // Home is org-wide — collab mirrors never count here (count or performance).
  const posts = postData?.posts?.filter((p) => !p.is_collab_mirror) ?? null;

  const today = todayStr();
  const firstName = (user?.name || user?.email || "").split(" ")[0].split("@")[0];

  // The greeting ("Good morning/afternoon/evening") needs an actual clock
  // tick to stay correct — without one, a tab left open across noon or 5pm
  // keeps showing whatever it computed on the last render forever, since
  // nothing else on this page re-renders on a fixed schedule.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const ops = useMemo(() => {
    // My Day is personal for EVERYONE, admins included — it's each person's
    // own view of what's on their plate, not a team-wide dashboard (the Task
    // Board already covers oversight). Someone with no linked roster record
    // simply sees none of their own.
    const scoped = (tasks ?? []).filter((t) => user?.editorId != null && t.editor_id === user.editorId);
    const open = scoped.filter((t) => t.status !== "done" && t.due_date);
    const overdue = open.filter((t) => (t.due_date as string) < today);
    const dueToday = open.filter((t) => t.due_date === today);
    const needAction = [...overdue, ...dueToday]
      .sort((a, b) => (a.due_date as string).localeCompare(b.due_date as string))
      .slice(0, 6);
    return { overdue: overdue.length, dueToday: dueToday.length, needAction };
  }, [tasks, today, user?.editorId]);

  // ---- "Your Score" — gamified Media House points, Today / This week / This
  // month, reusing the exact same points formula the Media House Leaders
  // board scores by (see lib/task-points). Only meaningful for someone linked
  // to a roster record — same gate as the rest of My Day's personal scoping.
  const scoreWindows = useMemo(() => {
    if (!editors || !tasks || !user?.editorId) return null;
    const eid = user.editorId;
    return {
      today: myRankInRange(editors, tasks, today, today, eid),
      week: myRankInRange(editors, tasks, weekStartStr(), today, eid),
      month: myRankInRange(editors, tasks, monthStartStr(), today, eid),
    };
  }, [editors, tasks, today, user?.editorId]);

  const pipeline = useMemo(() => {
    const c: Record<string, number> = { not_started: 0, in_progress: 0, in_review: 0, pending: 0, completed: 0 };
    for (const p of posts ?? []) c[p.edit_stage] = (c[p.edit_stage] ?? 0) + 1;
    return c;
  }, [posts]);

  const awaitingMetrics = useMemo(
    () => (posts ?? []).filter((p) => p.status === "published" && p.reach === 0).length,
    [posts],
  );

  const analytics = useMemo(() => {
    const b = rangeFor("thismonth");
    const pub = (posts ?? []).filter((p) => p.status === "published" && inRange(p.date, b.from, b.to));
    const views = pub.reduce((a, p) => a + p.views, 0);
    const reach = pub.reduce((a, p) => a + p.reach, 0);
    const eng = pub.reduce((a, p) => a + p.likes + p.comments + p.shares + p.saves, 0);
    const top = [...pub].sort((a, b) => performanceScore(b) - performanceScore(a))[0];
    return {
      views, posts: pub.length,
      engRate: reach ? (eng / reach) * 100 : null,
      top,
    };
  }, [posts]);

  const loading = tasks === null || posts === null;
  const pipelineTotal = Object.values(pipeline).reduce((a, b) => a + b, 0);

  const STATS: { label: string; value: number; tone: string; to: string }[] = [
    { label: "Overdue tasks", value: ops.overdue, tone: "danger", to: "/tasks" },
    { label: "Due today", value: ops.dueToday, tone: "warn", to: "/tasks" },
    { label: "Awaiting metrics", value: awaitingMetrics, tone: "accent", to: "/posts" },
    { label: "In review", value: pipeline.in_review, tone: "info", to: "/metrics" },
  ];

  return (
    <section className="screen">
      {/* Top Performer of the Month — celebratory ticker above everything. */}
      <TopPerformerTicker />

      {/* Hero */}
      <div className="home-hero">
        <div>
          <h2 className="home-greet">{greeting(now)}{firstName ? `, ${firstName}` : ""} 👋</h2>
          <p className="home-sub">Here's what needs your attention today.</p>
        </div>
        <div className="home-actions">
          <button className="btn" onClick={() => navigate("/tasks")}>✅ New Task</button>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/posts/new", { state: { backgroundLocation: location } })}
          >＋ Add Post</button>
        </div>
      </div>

      {!user?.editorId && (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
          Your account isn't linked to a team member yet, so My Day and your score have nothing personal to show.
          Ask an admin to link you under Settings → Team.
        </div>
      )}

      {/* Your Score — gamified Media House points, so finishing work on time
          feels like a win, not just a checkbox. Hidden entirely for anyone
          not linked to a roster record — same gate My Day itself uses. */}
      {scoreWindows && (
        <div className="score-strip">
          {([
            ["today", "Today", scoreWindows.today],
            ["week", "This week", scoreWindows.week],
            ["month", "This month", scoreWindows.month],
          ] as const).map(([key, label, w]) => (
            <div key={key} className={"score-tile" + (w.rank === 1 ? " top" : "")}>
              <div className="score-tile-label">{label}</div>
              <div className="score-tile-rank">
                {w.rank ? (RANK_BADGE[w.rank] ?? `#${w.rank}`) : "—"}
              </div>
              <div className="score-tile-pts">{w.points.toFixed(1)} pts</div>
              <div className="score-tile-sub">
                {w.rank ? `of ${w.totalRanked} scoring` : "no points yet"}
              </div>
            </div>
          ))}
          <Link to="/leaderboard" className="score-strip-link">🏆 Full leaderboard →</Link>
        </div>
      )}

      {/* Attention strip */}
      <div className="home-stats">
        {STATS.map((s) => (
          <button key={s.label} className={"home-stat " + s.tone} onClick={() => navigate(s.to)}>
            <div className="hs-v">{loading ? "—" : s.value}</div>
            <div className="hs-l">{s.label}</div>
            <div className="hs-go">View →</div>
          </button>
        ))}
      </div>

      <MyGoalScore />

      {/* Two pillars */}
      <div className="home-cols">
        {/* Operations */}
        <div className="home-col">
          <div className="home-colhead"><span className="hc-tag ops">Operations</span><h3>Needs action</h3>
            <Link to="/tasks" className="hc-link">Task Board →</Link>
          </div>
          <div className="card pad">
            {loading ? (
              <div className="hint">Loading…</div>
            ) : ops.needAction.length === 0 ? (
              <div className="home-empty">🎉 All caught up — no overdue or due-today tasks.</div>
            ) : (
              <div className="need-list">
                {ops.needAction.map((t) => {
                  const overdue = (t.due_date as string) < today;
                  return (
                    <div className="need-row" key={t.id}>
                      {t.editor_image ? (
                        <img className="need-ava" src={t.editor_image} alt={t.editor_name ?? ""} />
                      ) : (
                        <span className="need-ava init">{(t.editor_name ?? "?").charAt(0)}</span>
                      )}
                      <div className="need-main">
                        <div className="need-title">{t.title}</div>
                        <div className="need-meta">{t.editor_name ?? "Unassigned"}{t.channel_name ? ` · ${t.channel_name}` : ""}</div>
                      </div>
                      <span className={"need-due " + (overdue ? "over" : "today")}>{overdue ? "Overdue" : "Today"}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pipeline snapshot */}
          <div className="home-colhead" style={{ marginTop: 22 }}>
            <span className="hc-tag ops">Pipeline</span><h3>Editing progress</h3>
            <Link to="/metrics" className="hc-link">Open →</Link>
          </div>
          <div className="card pad">
            {pipelineTotal === 0 ? (
              <div className="home-empty">No content in the pipeline yet.</div>
            ) : (
              <>
                <div className="pipe-bar">
                  {(["completed", "in_review", "pending", "in_progress", "not_started"] as const).map((k) =>
                    pipeline[k] > 0 ? (
                      <div key={k} className={"pipe-seg " + STAGE_META[k].cls}
                        style={{ flex: pipeline[k] }} title={`${STAGE_META[k].label}: ${pipeline[k]}`} />
                    ) : null,
                  )}
                </div>
                <div className="pipe-legend">
                  {(["not_started", "in_progress", "in_review", "pending", "completed"] as const).map((k) => (
                    <span key={k} className="pipe-leg"><span className={"pipe-dot " + STAGE_META[k].cls} />{STAGE_META[k].label} <b>{pipeline[k]}</b></span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Analytics */}
        <div className="home-col">
          <div className="home-colhead"><span className="hc-tag ana">Analytics</span><h3>This month</h3>
            <Link to="/dashboard" className="hc-link">Dashboard →</Link>
          </div>
          <div className="grid g2" style={{ gap: 14 }}>
            <div className="card kpi"><div className="ic">👁️</div><div className="l">Total Views</div><div className="v">{loading ? "—" : compactNum(analytics.views)}</div><div className="d flat">{analytics.posts} published</div></div>
            <div className="card kpi"><div className="ic">⚡</div><div className="l">Engagement Rate</div><div className="v">{analytics.engRate == null ? "—" : analytics.engRate.toFixed(1) + "%"}</div><div className="d flat">of accounts reached</div></div>
          </div>

          <div className="home-colhead" style={{ marginTop: 22 }}>
            <span className="hc-tag ana">Top mover</span><h3>Best post this month</h3>
          </div>
          <div className="card pad">
            {loading ? (
              <div className="hint">Loading…</div>
            ) : analytics.top ? (
              <div className="topmover">
                <div className="tm-rank">🥇</div>
                <div className="tm-main">
                  <div className="tm-title">{analytics.top.title}</div>
                  <div className="tm-meta">{(analytics.top as Post & { channel_name?: string }).channel_name ?? ""}</div>
                  <div className="tm-stats">
                    <span>Score <b>{formatScore(analytics.top)}</b></span>
                    <span>Views <b>{compactNum(analytics.top.views)}</b></span>
                    <span>Saves <b>{compactNum(analytics.top.saves)}</b></span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="home-empty">No published posts this month yet.</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// The signed-in editor's own monthly goal score (Earned 80% + Discipline 20% =
// Overall) — read-only, current month, their figures only. Hidden when they
// have no linked editor record or no goals set this month.
function currentMonthFirst(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function MyGoalScore() {
  const { user } = useAuth();
  const [data, setData] = useState<{ rows: { goalJC: number; actualJC: number; points: number }[]; ratings: Ratings } | null>(null);
  useEffect(() => {
    if (!user?.editorId) return;
    api<{ rows: { goalJC: number; actualJC: number; points: number }[]; ratings: Ratings }>(`/goals/my-breakdown?month=${currentMonthFirst()}`)
      .then((d) => setData(d))
      .catch(() => {});
  }, [user?.editorId]);
  if (!user?.editorId || !data) return null;
  const bd = goalBreakdown(data.rows, data.ratings ?? {});
  if (!bd) return null; // no goals assigned this month
  const w = (n: number) => Math.round(n);
  return (
    <>
      <div className="home-colhead" style={{ marginTop: 4 }}>
        <span className="hc-tag ops">This month</span><h3>Your goal score</h3>
      </div>
      <div className="home-stats" style={{ marginBottom: 10 }}>
        <div className="home-stat accent"><div className="hs-v">{w(bd.earned)}</div><div className="hs-l">Earned (80%)</div></div>
        <div className="home-stat info"><div className="hs-v">{w(bd.discipline)}{!bd.reviewed ? "*" : ""}</div><div className="hs-l">Discipline (20%)</div></div>
        <div className="home-stat"><div className="hs-v">{w(bd.overall)}</div><div className="hs-l">Overall / {w(bd.total)}</div></div>
      </div>
      {/* The 5 criteria behind the discipline number — "where did I lose points". */}
      <div className="card pad" style={{ marginBottom: 18, display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5 }}>
        {DISCIPLINE_CRITERIA.map((c) => {
          const v = data.ratings?.[c.key];
          return (
            <span key={c.key}>{c.label}: <b>{v == null ? "5" : v}</b>/5{v == null ? <span className="st dim"> (default)</span> : ""}</span>
          );
        })}
        {!bd.reviewed && <span className="st dim">* not yet fully reviewed</span>}
      </div>
    </>
  );
}
