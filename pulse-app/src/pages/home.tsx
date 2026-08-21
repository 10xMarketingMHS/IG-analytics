import { useMemo } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTasks } from "@/lib/use-tasks";
import { useResource } from "@/lib/use-resource";
import { rangeFor, inRange, compactNum } from "@/lib/date-range";
import { performanceScore, formatScore } from "@/lib/score";
import type { Post } from "@/lib/types";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

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
  const { tasks } = useTasks();
  const { data: postData } = useResource<{ posts: (Post & { channel_name?: string })[] }>("/posts?channel=all");
  // Home is org-wide — collab mirrors never count here (count or performance).
  const posts = postData?.posts?.filter((p) => !p.is_collab_mirror) ?? null;

  const today = todayStr();

  const ops = useMemo(() => {
    const open = (tasks ?? []).filter((t) => t.status !== "done" && t.due_date);
    const overdue = open.filter((t) => (t.due_date as string) < today);
    const dueToday = open.filter((t) => t.due_date === today);
    const needAction = [...overdue, ...dueToday]
      .sort((a, b) => (a.due_date as string).localeCompare(b.due_date as string))
      .slice(0, 6);
    return { overdue: overdue.length, dueToday: dueToday.length, needAction };
  }, [tasks, today]);

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
      {/* Hero */}
      <div className="home-hero">
        <div>
          <h2 className="home-greet">{greeting()} 👋</h2>
          <p className="home-sub">Here's what needs your attention across <b>Media House</b> today.</p>
        </div>
        <div className="home-actions">
          <button className="btn" onClick={() => navigate("/tasks")}>✅ New Task</button>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/posts/new", { state: { backgroundLocation: location } })}
          >＋ Add Post</button>
        </div>
      </div>

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
