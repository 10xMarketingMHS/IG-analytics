import { useMemo, useState } from "react";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import type { Task, TaskType } from "@/lib/types";

// This page is scoped to Social + Ad work only — the admin's day-to-day
// Task Board covers everything, but checking it constantly for "who's
// editing which reel/ad right now" is too much friction. This is that
// narrower, editor-focused view: just the work that maps to actual
// video/creative output, one row per task, grouped by pipeline stage.
//
// "Social" here means every post-linked task too (task_type "content" —
// auto-created the moment a post is added, one per Reel/Carousel/post),
// not just the ones someone manually typed as "Social Media" on the Task
// Board. That auto-created bucket is where the real day-to-day editing
// work actually lives; a manually-typed "social" task is the exception,
// not the rule, so both count as the same "Social" pipeline.
type TypeFilter = "all" | "social" | "ad";
const TYPE_ICON: Record<TaskType, string> = { content: "📄", short_task: "⚡", general: "🗒️", social: "📱", ad: "📢", admin: "🛠️" };
function pipelineBucket(t: Task): "social" | "ad" | null {
  if (t.task_type === "ad") return "ad";
  if (t.task_type === "content" || t.task_type === "social") return "social";
  return null;
}

// Five pipeline stages — the first two ("Pending accept" / "Not started")
// split what used to be a single "todo" bucket, because whether the
// assignee has actually accepted the work is exactly the kind of thing
// this page exists to surface.
type Stage = "pending_accept" | "not_started" | "in_progress" | "in_review" | "completed";
const STAGES: { key: Stage; label: string; cls: string }[] = [
  { key: "pending_accept", label: "Pending Accept", cls: "pd" },
  { key: "not_started", label: "Not Started", cls: "ns" },
  { key: "in_progress", label: "In Progress", cls: "ip" },
  { key: "in_review", label: "In Review", cls: "ir" },
  { key: "completed", label: "Completed", cls: "cp" },
];
function stageOf(t: Task): Stage {
  if (t.editor_id && !t.accepted) return "pending_accept";
  if (t.status === "todo") return "not_started";
  if (t.status === "in_progress") return "in_progress";
  if (t.status === "review") return "in_review";
  return "completed";
}

// Best-effort platform guess — social/ad tasks aren't always linked to a
// Post (which is the only place a real platform_id lives), so fall back to
// the free-text platform field editors type into the task form.
function resolvePlatformKey(t: Task): string | undefined {
  if (t.platform_key) return t.platform_key;
  const label = t.meta?.platform;
  if (!label) return undefined;
  const l = label.toLowerCase();
  if (l.includes("insta")) return "instagram";
  if (l.includes("face") || l.includes("meta")) return "facebook";
  if (l.includes("you")) return "youtube";
  return undefined;
}

function PlatformLogo({ k, title }: { k?: string; title?: string }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", "aria-label": title } as const;
  if (k === "instagram") {
    return (
      <svg {...common}>
        <defs>
          <radialGradient id="iglg2" cx="0.3" cy="1" r="1.1">
            <stop offset="0" stopColor="#fed373" />
            <stop offset="0.35" stopColor="#f15245" />
            <stop offset="0.7" stopColor="#d92e7f" />
            <stop offset="1" stopColor="#9b36b7" />
          </radialGradient>
        </defs>
        <rect width="24" height="24" rx="7" fill="url(#iglg2)" />
        <rect x="5" y="5" width="14" height="14" rx="4.5" fill="none" stroke="#fff" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.4" fill="none" stroke="#fff" strokeWidth="1.8" />
        <circle cx="16.5" cy="7.5" r="1.1" fill="#fff" />
      </svg>
    );
  }
  if (k === "youtube") {
    return (
      <svg {...common}>
        <rect y="3.5" width="24" height="17" rx="5" fill="#ff0000" />
        <path d="M10 8.2 L16 12 L10 15.8 Z" fill="#fff" />
      </svg>
    );
  }
  if (k === "facebook") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="11" fill="#1877f2" />
        <path d="M14.6 8.1h-1.7c-.4 0-.7.3-.7.8V11h2.3l-.35 2.3h-1.95V20h-2.4v-6.7H8.1V11h1.7V9.2c0-1.8 1.05-2.9 2.85-2.9h1.95z" fill="#fff" />
      </svg>
    );
  }
  return <span title={title}>🌐</span>;
}

function relTime(iso: string | null) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysOverdue(due: string): number {
  const [dy, dm, dd] = due.split("-").map(Number);
  const [ty, tm, td] = todayStr().split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
}

export function MetricsPage() {
  const { tasks: allTasks } = useTasks();
  const { editors } = useEditors();

  // Only social + ad work belongs on this page — short_task/general are the
  // Task Board's job. See pipelineBucket() above for what counts as "social".
  const pipelineTasks = useMemo(
    () => (allTasks ?? []).filter((t) => pipelineBucket(t) !== null),
    [allTasks],
  );

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [editorFilter, setEditorFilter] = useState("");
  const [stageFilter, setStageFilter] = useState<"" | Stage>("");

  const rows = useMemo(() => {
    let r = pipelineTasks;
    if (typeFilter !== "all") r = r.filter((t) => pipelineBucket(t) === typeFilter);
    if (editorFilter) r = r.filter((t) => t.editor_id === editorFilter);
    if (stageFilter) r = r.filter((t) => stageOf(t) === stageFilter);
    return r;
  }, [pipelineTasks, typeFilter, editorFilter, stageFilter]);

  const counts = useMemo(() => {
    const c: Record<Stage, number> = { pending_accept: 0, not_started: 0, in_progress: 0, in_review: 0, completed: 0 };
    for (const t of rows) c[stageOf(t)]++;
    return c;
  }, [rows]);
  const total = rows.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const completedPct = pct(counts.completed);
  const socialCount = rows.filter((t) => pipelineBucket(t) === "social").length;
  const adCount = rows.filter((t) => pipelineBucket(t) === "ad").length;

  if (allTasks === null) return <section className="screen"><div className="hint">Loading…</div></section>;

  return (
    <section className="screen">
      <div className="toolbar" style={{ alignItems: "center", marginBottom: 10 }}>
        <select className="t" style={{ maxWidth: 200 }} value={editorFilter} onChange={(e) => setEditorFilter(e.target.value)}>
          <option value="">All Editors</option>
          {(editors ?? []).map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
        </select>
        <select className="t" style={{ maxWidth: 180 }} value={stageFilter} onChange={(e) => setStageFilter(e.target.value as Stage | "")}>
          <option value="">All Stages</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <div className="spacer" />
        <div className="seg">
          <button className={typeFilter === "all" ? "on" : ""} onClick={() => setTypeFilter("all")}>All</button>
          <button className={typeFilter === "social" ? "on" : ""} onClick={() => setTypeFilter("social")}>📱 Social</button>
          <button className={typeFilter === "ad" ? "on" : ""} onClick={() => setTypeFilter("ad")}>📢 Ads</button>
        </div>
      </div>

      {/* One consolidated stats panel instead of KPI cards + a separate donut —
          same numbers, no redundancy between them. */}
      <div className="card pad mx-summary">
        <div className="mx-summary-top">
          <div className="mx-summary-num">
            <b>{total}</b> task{total === 1 ? "" : "s"}
            <span className="mx-summary-split">{socialCount} social · {adCount} ads</span>
          </div>
          <div className="mx-summary-pct"><b>{completedPct}%</b> completed</div>
        </div>
        <div className="mx-stackbar">
          {total === 0 ? (
            <div className="mx-stackbar-empty" />
          ) : (
            STAGES.map((s) => counts[s.key] > 0 && (
              <div
                key={s.key}
                className={"mx-stackbar-seg " + s.cls}
                style={{ width: `${pct(counts[s.key])}%` }}
                title={`${s.label}: ${counts[s.key]}`}
              />
            ))
          )}
        </div>
        <div className="mx-legend">
          {STAGES.map((s) => (
            <button
              key={s.key}
              className={"mx-leg" + (stageFilter === s.key ? " on" : "")}
              onClick={() => setStageFilter(stageFilter === s.key ? "" : s.key)}
              title={`Filter to ${s.label}`}
            >
              <span className={"mx-dot " + s.cls} />
              <span className="mx-leg-l">{s.label}</span>
              <span className="mx-leg-n">{counts[s.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sectitle" style={{ margin: "12px 2px 8px" }}><span className="dot" />Social & Ads pipeline<span className="s">{total} task{total === 1 ? "" : "s"} · who's working on what</span></div>

      {rows.length === 0 ? (
        <div className="card pad mx-empty">
          <span className="mx-empty-ic">🎬</span>
          No social or ad tasks match these filters.
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl mx-tbl">
            <thead>
              <tr><th>Title</th><th>ID</th><th>Channel</th><th>Editor</th><th>Stage</th><th>Due date</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const ed = editors?.find((e) => e.id === t.editor_id);
                const stage = STAGES.find((s) => s.key === stageOf(t))!;
                const bucket = pipelineBucket(t)!;
                // Social/Ad id only — no TID fallback, per the request that this
                // page shouldn't surface the general task id at all.
                const idLabel = t.task_type === "ad" ? t.ad_id : t.sid;
                const overdue = t.due_date && stage.key !== "completed" && t.due_date < todayStr();
                return (
                  <tr key={t.id} className={"mx-row " + bucket}>
                    <td>
                      <div style={{ fontWeight: 700 }}>
                        <span style={{ marginRight: 5 }}>{TYPE_ICON[t.task_type]}</span>
                        {t.title}
                      </div>
                    </td>
                    <td>{idLabel ? <span className="mx-idchip">{idLabel}</span> : <span style={{ color: "var(--faint)" }}>—</span>}</td>
                    <td>
                      <span className="mx-chan">
                        <PlatformLogo k={resolvePlatformKey(t)} title={t.meta?.platform || t.channel_name || undefined} />
                        <span>{t.channel_name ?? t.meta?.platform ?? "—"}</span>
                      </span>
                    </td>
                    <td>
                      {ed ? (
                        <span className="mx-ed">
                          {ed.image_url ? <img src={ed.image_url} alt={ed.name} /> : <span className="mx-ed-i">{ed.name.charAt(0)}</span>}
                          {ed.name}
                        </span>
                      ) : <span style={{ color: "var(--faint)" }}>Unassigned</span>}
                    </td>
                    <td>
                      {/* Read-only — changing stage has real rules (accept, admin-only
                          review resolution) that live on the Task Board, not here. */}
                      <span className={"mx-stage " + stage.cls} style={{ cursor: "default" }}>{stage.label}</span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {t.due_date ?? "—"}
                      {overdue && <span className="mx-overdue">{daysOverdue(t.due_date!)}d overdue</span>}
                    </td>
                    <td style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{relTime(t.completed_at ?? t.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
