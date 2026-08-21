import { useEffect, useMemo, useState } from "react";
import { useResource } from "@/lib/use-resource";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Post, Platform, Taxonomy, EditStage } from "@/lib/types";

const STAGES: { key: EditStage; label: string; cls: string }[] = [
  { key: "not_started", label: "Not Started", cls: "ns" },
  { key: "in_progress", label: "In Progress", cls: "ip" },
  { key: "in_review", label: "In Review", cls: "ir" },
  { key: "pending", label: "Pending", cls: "pd" },
  { key: "completed", label: "Completed", cls: "cp" },
];
// Brand logos (logo only — no text) for a clean, minimal Channel column.
function PlatformLogo({ k, title }: { k?: string; title?: string }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", "aria-label": title } as const;
  if (k === "instagram") {
    return (
      <svg {...common}>
        <defs>
          <radialGradient id="iglg" cx="0.3" cy="1" r="1.1">
            <stop offset="0" stopColor="#fed373" />
            <stop offset="0.35" stopColor="#f15245" />
            <stop offset="0.7" stopColor="#d92e7f" />
            <stop offset="1" stopColor="#9b36b7" />
          </radialGradient>
        </defs>
        <rect width="24" height="24" rx="7" fill="url(#iglg)" />
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
  return <span title={title}>📱</span>;
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

export function MetricsPage() {
  const { data: postData, refetch } = useResource<{ posts: (Post & { channel_name?: string })[] }>("/posts?channel=all");
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { editors } = useEditors();
  const { workspaces } = useWorkspaces();
  // Editing Pipeline is per-post workflow — a collab mirror is the same edit
  // job as its owner, so it never shows as its own pipeline card.
  const posts = postData?.posts?.filter((p) => !p.is_collab_mirror) ?? null;
  const platformById = useMemo(() => new Map((platData?.platforms ?? []).map((p) => [p.id, p])), [platData]);
  const editorById = useMemo(() => new Map((editors ?? []).map((e) => [e.id, e])), [editors]);

  // Merge every channel's pillar names so we can show the "#pillar" tag.
  const [pillarById, setPillarById] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancel = false;
    Promise.all(workspaces.map((w) => api<Taxonomy>(`/taxonomy?channel=${w.id}`).catch(() => null))).then((all) => {
      if (cancel) return;
      const m: Record<string, string> = {};
      for (const t of all) if (t) for (const p of t.pillars) m[p.id] = p.name;
      setPillarById(m);
    });
    return () => { cancel = true; };
  }, [workspaces]);

  const [editorFilter, setEditorFilter] = useState("");
  const [stageFilter, setStageFilter] = useState<"" | EditStage>("");

  const rows = useMemo(() => {
    let r = posts ?? [];
    if (editorFilter) r = r.filter((p) => p.editor_id === editorFilter);
    if (stageFilter) r = r.filter((p) => p.edit_stage === stageFilter);
    return r;
  }, [posts, editorFilter, stageFilter]);

  const counts = useMemo(() => {
    const c: Record<EditStage, number> = { not_started: 0, in_progress: 0, in_review: 0, pending: 0, completed: 0 };
    for (const p of rows) c[p.edit_stage] = (c[p.edit_stage] ?? 0) + 1;
    return c;
  }, [rows]);
  const total = rows.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const completedPct = pct(counts.completed);

  async function setStage(post: Post, stage: EditStage) {
    try {
      await api(`/posts/${post.id}`, { method: "PATCH", body: JSON.stringify({ editStage: stage }) });
      refetch();
    } catch {
      toast.error("Could not update stage.");
    }
  }

  if (posts === null) return <section className="screen"><div className="hint">Loading…</div></section>;

  const KPIS: [string, string, number, string][] = [
    ["📋", "Total Tasks", total, "tint-indigo"],
    ["✅", "Completed", counts.completed, "tint-teal"],
    ["🔄", "In Progress", counts.in_progress, "tint-amber"],
    ["🕓", "Pending", counts.pending, "tint-rose"],
  ];

  return (
    <section className="screen">
      <div className="toolbar" style={{ alignItems: "center" }}>
        <select className="t" style={{ maxWidth: 200 }} value={editorFilter} onChange={(e) => setEditorFilter(e.target.value)}>
          <option value="">All Editors</option>
          {(editors ?? []).map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
        </select>
        <select className="t" style={{ maxWidth: 180 }} value={stageFilter} onChange={(e) => setStageFilter(e.target.value as EditStage | "")}>
          <option value="">All Stages</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <div className="spacer" />
      </div>

      <div className="grid g4">
        {KPIS.map(([ic, label, val, tint]) => (
          <div className="card kpi" key={label}>
            <div className={"ic " + tint}>{ic}</div>
            <div className="l">{label}</div>
            <div className="v">{val}</div>
            <div className="d flat">{label === "Total Tasks" ? "across all channels" : pct(val) + "% of total"}</div>
          </div>
        ))}
      </div>

      <div className="card pad" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 30, flexWrap: "wrap" }}>
        <div className="mx-donut">
          <svg width="132" height="132" viewBox="0 0 42 42">
            <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--border)" strokeWidth="4" />
            <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--accent)" strokeWidth="4"
              strokeDasharray={`${completedPct} ${100 - completedPct}`} strokeDashoffset="25" strokeLinecap="round" />
            <text x="21" y="20" textAnchor="middle" fontSize="8" fontWeight="800" fill="var(--text)">{completedPct}%</text>
            <text x="21" y="27" textAnchor="middle" fontSize="3.4" fill="var(--muted)">Completed</text>
          </svg>
        </div>
        <div className="mx-legend">
          {STAGES.map((s) => (
            <div className="mx-leg" key={s.key}>
              <span className={"mx-dot " + s.cls} />
              <div>
                <div className="mx-leg-l">{s.label}</div>
                <div className="mx-leg-n">{counts[s.key]} <span>Tasks</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sectitle"><span className="dot" />Editing pipeline<span className="s">{total} post{total === 1 ? "" : "s"} across all channels</span></div>

      {rows.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>No posts match these filters.</div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl mx-tbl">
            <thead>
              <tr><th>Title</th><th>Channel</th><th>Editor</th><th>Stage</th><th>Due date</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const pf = p.platform_id ? platformById.get(p.platform_id) : undefined;
                const ed = p.editor_id ? editorById.get(p.editor_id) : undefined;
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{p.title}</div>
                      {pillarById[p.pillar_id] && <div style={{ fontSize: 11.5, color: "var(--accent-ink)", fontWeight: 700 }}>#{pillarById[p.pillar_id].replace(/\s+/g, "")}</div>}
                    </td>
                    <td title={p.channel_name ?? ""}>
                      <span className="mx-chan"><PlatformLogo k={pf?.key} title={pf?.name} /></span>
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
                      <select
                        className={"mx-stage " + (STAGES.find((s) => s.key === p.edit_stage)?.cls ?? "")}
                        value={p.edit_stage}
                        onChange={(e) => setStage(p, e.target.value as EditStage)}
                        title="Change stage"
                      >
                        {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{p.date}</td>
                    <td style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{relTime(p.updated_at)}</td>
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
