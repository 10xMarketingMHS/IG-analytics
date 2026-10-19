import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader } from "@/components/loader";
import { Icon } from "@/components/icon";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useTasks } from "@/lib/use-tasks";
import { notifyTasksChanged } from "@/lib/task-events";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { TaskPanel } from "@/pages/tasks";
import type { Editor, Task } from "@/lib/types";
import "./pipeline.css";

// Social & Ads Pipeline (Pulse Redesign v7): every reel, carousel and ad in
// production, scoped to Social + Ad work only — the Task Board covers
// everything else. Stages are read-only here (their rules live on the Task
// Board); a row opens the task. Two views: by stage (a table) and by account
// (a card per brand · platform). Unassigned work can be claimed.
//
// "Social" is every post-linked task too (task_type "content" — made the
// moment a post is added) as well as tasks typed "Social Media" on the board.

type TypeFilter = "all" | "social" | "ad";
type View = "stage" | "account";
function pipelineBucket(t: Task): "social" | "ad" | null {
  if (t.task_type === "ad") return "ad";
  if (t.task_type === "content" || t.task_type === "social") return "social";
  return null;
}

type Stage = "pending_accept" | "not_started" | "in_progress" | "in_review" | "completed";
const STAGES: { key: Stage; label: string; color: string; icon: string }[] = [
  { key: "pending_accept", label: "Pending Accept", color: "oklch(0.64 0.2 350)", icon: "hourglass_top" },
  { key: "not_started", label: "Not Started", color: "#a1a1aa", icon: "radio_button_unchecked" },
  { key: "in_progress", label: "In Progress", color: "oklch(0.72 0.15 70)", icon: "autorenew" },
  { key: "in_review", label: "In Review", color: "oklch(0.6 0.15 250)", icon: "rate_review" },
  { key: "completed", label: "Completed", color: "oklch(0.6 0.14 155)", icon: "check_circle" },
];
const STAGE_INDEX: Record<Stage, number> = { pending_accept: 0, not_started: 1, in_progress: 2, in_review: 3, completed: 4 };
function stageOf(t: Task): Stage {
  if (t.status === "done") return "completed";
  if (t.status === "review") return "in_review";
  if (t.editor_id && !t.accepted) return "pending_accept";
  if (t.status === "in_progress") return "in_progress";
  return "not_started";
}
const TYPE_COLOR = { social: "oklch(0.6 0.16 255)", ad: "oklch(0.66 0.17 45)" } as const;

// Best-effort platform: social/ad tasks aren't always linked to a post (the
// only place a real platform lives), so fall back to the typed platform field.
function platformOf(t: Task): "instagram" | "facebook" | "youtube" | null {
  const k = t.platform_key;
  if (k === "instagram" || k === "facebook" || k === "youtube") return k;
  const l = String(t.meta?.platform ?? "").toLowerCase();
  if (l.includes("insta")) return "instagram";
  if (l.includes("face") || l.includes("meta")) return "facebook";
  if (l.includes("you")) return "youtube";
  return null;
}
const PLATFORM = {
  instagram: { l: "Instagram", ab: "IG", bg: "linear-gradient(135deg,#f9a03f,#e1306c 55%,#833ab4)", c: "#e1306c" },
  facebook: { l: "Facebook", ab: "FB", bg: "linear-gradient(135deg,#3b82f6,#1d4ed8)", c: "#1d4ed8" },
  youtube: { l: "YouTube", ab: "YT", bg: "linear-gradient(135deg,#ff4b4b,#cc0000)", c: "#cc0000" },
  none: { l: "No platform", ab: "—", bg: "linear-gradient(135deg,#a1a1aa,#71717a)", c: "#71717a" },
} as const;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayDiff(a: string, b: string) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
// The due cell: icon, words and tone.
function dueOf(t: Task, today: string): { icon: string; l: string; tone: string } {
  if (t.status === "done") return { icon: "check_circle", l: "Done", tone: "good" };
  if (!t.due_date) return { icon: "event", l: "No due date", tone: "faint" };
  const d = dayDiff(today, t.due_date);
  if (d < 0) return { icon: "error", l: `Overdue · ${-d}d`, tone: "bad" };
  if (d === 0) return { icon: "schedule", l: "Today", tone: "warn" };
  if (d === 1) return { icon: "event", l: "Tomorrow", tone: "" };
  if (d <= 6) return { icon: "event", l: "This week", tone: "muted" };
  return { icon: "event", l: new Date(t.due_date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }), tone: "muted" };
}
function relTime(iso: string | null) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const refOf = (t: Task) => (t.task_type === "ad" ? t.ad_id : t.sid) ?? null;
const lastTouch = (t: Task) => t.completed_at ?? t.review_started_at ?? t.budget_started_at ?? t.created_at;

function Ava({ editor, size = 26 }: { editor: Editor | null; size?: number }) {
  if (editor?.image_url) return <img className="pp-ava" src={editor.image_url} alt="" style={{ width: size, height: size }} />;
  const name = editor?.name ?? "?";
  return <span className="pp-ava" style={{ width: size, height: size, background: editor ? gradFor(name) : "var(--pp-sunk2)" }}>{editor ? initialsOf(name) : "?"}</span>;
}

export function MetricsPage() {
  const { tasks: allTasks, refetch } = useTasks();
  const { editors } = useEditors();
  const { user } = useAuth();
  const { active, workspaces } = useWorkspaces();
  const canWrite = active?.role !== "viewer";

  const pipelineTasks = useMemo(() => (allTasks ?? []).filter((t) => pipelineBucket(t) !== null), [allTasks]);
  const [view, setView] = useState<View>("stage");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [editorFilter, setEditorFilter] = useState(""); // "" all, "none" unclaimed, else an editor id
  const [stageFilter, setStageFilter] = useState<"" | Stage>("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const today = todayStr();
  const edOf = (id: string | null) => (id ? (editors ?? []).find((e) => e.id === id) ?? null : null);

  // Type, editor and search shape the totals, the bar and the stage cards;
  // the stage filter then narrows the list.
  const pre = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pipelineTasks.filter((t) =>
      (typeFilter === "all" || pipelineBucket(t) === typeFilter)
      && (!editorFilter || (editorFilter === "none" ? !t.editor_id : t.editor_id === editorFilter))
      && (!needle || t.title.toLowerCase().includes(needle) || (refOf(t) ?? "").toLowerCase().includes(needle)));
  }, [pipelineTasks, typeFilter, editorFilter, q]);
  const rows = useMemo(() => pre
    .filter((t) => !stageFilter || stageOf(t) === stageFilter)
    .sort((a, b) => STAGE_INDEX[stageOf(a)] - STAGE_INDEX[stageOf(b)]
      || Number(!!b.due_date && b.due_date < today && b.status !== "done") - Number(!!a.due_date && a.due_date < today && a.status !== "done")
      || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")), [pre, stageFilter, today]);
  const byStage = useMemo(() => {
    const m = new Map<Stage, Task[]>(STAGES.map((s) => [s.key, []]));
    for (const t of pre) m.get(stageOf(t))!.push(t);
    return m;
  }, [pre]);
  const overdue = pre.filter((t) => t.status !== "done" && t.due_date && t.due_date < today).length;
  const social = pre.filter((t) => pipelineBucket(t) === "social").length;
  const ads = pre.filter((t) => pipelineBucket(t) === "ad").length;
  const filtered = typeFilter !== "all" || !!editorFilter || !!stageFilter || !!q.trim();
  const accounts = useMemo(() => {
    const m = new Map<string, { key: string; brand: string; plat: keyof typeof PLATFORM; tasks: Task[] }>();
    for (const t of rows) {
      const plat = platformOf(t) ?? "none";
      const brand = t.channel_name ?? "No brand";
      const key = `${brand}|${plat}`;
      if (!m.has(key)) m.set(key, { key, brand, plat, tasks: [] });
      m.get(key)!.tasks.push(t);
    }
    return [...m.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.plat.localeCompare(b.plat));
  }, [rows]);

  async function claim(t: Task) {
    if (!user?.editorId) { toast.error("You're not on the team roster yet."); return; }
    setClaiming(t.id);
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ editorId: user.editorId }) });
      await refetch();
      notifyTasksChanged();
      toast.success(`You claimed ${refOf(t) ?? t.title}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't claim that task.");
    } finally {
      setClaiming(null);
    }
  }
  const openTask = openId ? (allTasks ?? []).find((t) => t.id === openId) ?? null : null;

  if (allTasks === null) return <section className="screen"><Loader label="Loading…" /></section>;

  const typeCount = (k: TypeFilter) => (k === "all" ? pipelineTasks.length : pipelineTasks.filter((t) => pipelineBucket(t) === k).length);
  const claimBtn = (t: Task) => !t.editor_id && canWrite && t.status !== "done" && (
    <button type="button" className="pp-claim" disabled={claiming === t.id} onClick={(e) => { e.stopPropagation(); claim(t); }}>{claiming === t.id ? "…" : "Claim"}</button>
  );

  return (
    <section className="screen pp">
      {/* The title and description are in the top bar (lib/nav.ts PAGE_META). */}
      <div className="pp-top">
        <span className="pp-grow" />
        <div className="pp-seg" role="group" aria-label="View">
          {([["stage", "By stage", "view_list", rows.length], ["account", "By account", "account_tree", accounts.length]] as const).map(([k, l, ic, n]) => (
            <button key={k} type="button" className={view === k ? "on" : undefined} aria-pressed={view === k} onClick={() => setView(k)}>
              <Icon name={ic} size={17} />{l}<span className="pp-n">{n}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="pp-card pp-summary">
        <span className="pp-glow" aria-hidden="true" />
        <div className="pp-sumtop">
          <div className="pp-total">
            <b>{pre.length}</b>
            <span>
              <span className="pp-total-l">pieces in the pipeline</span>
              <span className="pp-split">
                <span><i style={{ background: TYPE_COLOR.social }} /><b>{social}</b> social</span>
                <span><i style={{ background: TYPE_COLOR.ad }} /><b>{ads}</b> ads</span>
                {overdue > 0 && <span className="bad"><b>{overdue}</b> overdue</span>}
              </span>
            </span>
          </div>
          <div className="pp-barwrap">
            <div className="pp-bar">
              {STAGES.map((s) => {
                const n = byStage.get(s.key)!.length;
                return n > 0 ? <span key={s.key} title={`${s.label}: ${n}`} style={{ flex: n, background: s.color, opacity: stageFilter && stageFilter !== s.key ? 0.3 : 1 }} /> : null;
              })}
            </div>
            <span className="pp-hint">Click a stage to filter · click again to clear</span>
          </div>
        </div>
        <div className="pp-stages">
          {STAGES.map((s) => {
            const list = byStage.get(s.key)!;
            const late = list.filter((t) => t.status !== "done" && t.due_date && t.due_date < today).length;
            const sub = s.key === "pending_accept" ? (list.length ? "needs a nudge" : "") : s.key === "completed" ? "so far" : late ? `${late} overdue` : "";
            const people = [...new Map(list.filter((t) => t.editor_id).map((t) => [t.editor_id, edOf(t.editor_id)])).values()];
            const on = stageFilter === s.key;
            return (
              <button key={s.key} type="button" className={"pp-stage" + (on ? " on" : "")} style={{ ["--c" as string]: s.color }}
                aria-pressed={on} onClick={() => setStageFilter(on ? "" : s.key)}>
                <span className="pp-stage-top">
                  <span className="pp-stage-ic"><Icon name={s.icon} size={18} /></span>
                  <span className="pp-stage-l">{s.label}</span>
                </span>
                <span className="pp-stage-n"><b>{list.length}</b>{sub && <em className={late && s.key !== "completed" && s.key !== "pending_accept" ? "bad" : ""}>{sub}</em>}</span>
                <span className="pp-stage-avs">
                  {people.slice(0, 4).map((e, i) => <span key={e?.id ?? i} className="pp-stack" title={e?.name}><Ava editor={e} size={22} /></span>)}
                  {people.length > 4 && <span className="pp-more">+{people.length - 4}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="pp-card pp-tools">
        <div className="pp-seg" role="group" aria-label="Type">
          {([["all", "All", "apps"], ["social", "Social", "photo_camera"], ["ad", "Ads", "campaign"]] as const).map(([k, l, ic]) => (
            <button key={k} type="button" className={typeFilter === k ? "on" : undefined} aria-pressed={typeFilter === k} onClick={() => setTypeFilter(k)}>
              <Icon name={ic} size={17} />{l}<span className="pp-n">{typeCount(k)}</span>
            </button>
          ))}
        </div>
        <label className="pp-select">
          <select value={editorFilter} onChange={(e) => setEditorFilter(e.target.value)} aria-label="Editor">
            <option value="">All editors</option>
            {(editors ?? []).filter((e) => e.active).map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
            <option value="none">Unclaimed</option>
          </select>
          <Icon name="expand_more" size={18} />
        </label>
        <label className="pp-select">
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value as Stage | "")} aria-label="Stage">
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <Icon name="expand_more" size={18} />
        </label>
        <label className="pp-search">
          <Icon name="search" size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, SID or AID…" aria-label="Search" />
        </label>
        {filtered && (
          <button type="button" className="pp-clear" onClick={() => { setTypeFilter("all"); setEditorFilter(""); setStageFilter(""); setQ(""); }}>Clear filters</button>
        )}
        <span className="pp-grow" />
        <span className="pp-showing">Showing <b>{rows.length}</b> task{rows.length === 1 ? "" : "s"}</span>
      </div>

      {view === "stage" ? (
        <section className="pp-card pp-table">
          <div className="pp-scroll">
            <div className="pp-grid">
              <div className="pp-th"><span>Title</span><span>ID</span><span>Channel</span><span>Editor</span><span>Stage</span><span>Due date</span><span className="r">Updated</span></div>
              {rows.map((t) => {
                const s = STAGES[STAGE_INDEX[stageOf(t)]];
                const bucket = pipelineBucket(t)!;
                const plat = PLATFORM[platformOf(t) ?? "none"];
                const ed = edOf(t.editor_id);
                const due = dueOf(t, today);
                const ref = refOf(t);
                return (
                  <div key={t.id} className="pp-tr" role="button" tabIndex={0} style={{ ["--tc" as string]: TYPE_COLOR[bucket] }}
                    onClick={() => setOpenId(t.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
                    <span className="pp-cell-title">
                      <b>{t.title}</b>
                      <span><em className="pp-type">{bucket === "ad" ? "AD" : "SOCIAL"}</em>{t.content_format_name ?? ""}</span>
                    </span>
                    <span>{ref ? <span className="pp-ref">{ref}</span> : <span className="pp-faint">—</span>}</span>
                    <span className="pp-chan">
                      <span className="pp-plat" style={{ background: plat.bg }}>{plat.ab}</span>
                      <span><b>{t.channel_name ?? "—"}</b><em>{plat.l}</em></span>
                    </span>
                    <span className="pp-ed">
                      {ed ? <><Ava editor={ed} /><b>{ed.name}</b></> : <><span className="pp-faint">Unclaimed</span>{claimBtn(t)}</>}
                    </span>
                    <span className="pp-stagecell">
                      <span className="pp-pill" style={{ ["--c" as string]: s.color }}>{s.label}</span>
                      <span className="pp-steps">{STAGES.map((x, i) => <i key={x.key} style={{ background: i <= STAGE_INDEX[s.key] ? s.color : undefined }} />)}</span>
                    </span>
                    <span className={"pp-due " + due.tone}><Icon name={due.icon} size={15} />{due.l}</span>
                    <span className="pp-upd">{relTime(lastTouch(t))}</span>
                  </div>
                );
              })}
              {rows.length === 0 && <div className="pp-none">Nothing in the pipeline matches these filters.</div>}
            </div>
          </div>
        </section>
      ) : (
        <div className="pp-accts">
          {accounts.length === 0 && <div className="pp-card pp-none">Nothing in the pipeline matches these filters.</div>}
          {accounts.map((g) => {
            const plat = PLATFORM[g.plat];
            const unclaimed = g.tasks.filter((t) => !t.editor_id).length;
            return (
              <section key={g.key} className="pp-card pp-acct">
                <div className="pp-acct-head" style={{ ["--c" as string]: plat.c }}>
                  <span className="pp-plat lg" style={{ background: plat.bg }}>{plat.ab}</span>
                  <span className="pp-acct-l"><b>{g.brand} · {plat.l}</b><em>{g.tasks.length} task{g.tasks.length === 1 ? "" : "s"}{unclaimed ? ` · ${unclaimed} unclaimed` : ""}</em></span>
                  <span className="pp-grow" />
                  <span className="pp-mini">
                    {STAGES.map((s) => {
                      const n = g.tasks.filter((t) => stageOf(t) === s.key).length;
                      return n ? <i key={s.key} style={{ flex: n, background: s.color }} /> : null;
                    })}
                  </span>
                </div>
                {g.tasks.map((t) => {
                  const s = STAGES[STAGE_INDEX[stageOf(t)]];
                  const ed = edOf(t.editor_id);
                  const due = dueOf(t, today);
                  return (
                    <div key={t.id} className="pp-arow" role="button" tabIndex={0} onClick={() => setOpenId(t.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
                      <Ava editor={ed} size={30} />
                      <span className="pp-arow-txt">
                        <b>{t.title}</b>
                        <span><i style={{ background: s.color }} />{s.label} · {ed?.name ?? "Unclaimed"}{refOf(t) ? ` · ${refOf(t)}` : ""}</span>
                      </span>
                      <span className="pp-arow-end">
                        {claimBtn(t)}
                        <span className={"pp-duepill " + due.tone}>{due.l}</span>
                      </span>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}

      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite={canWrite} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => { setOpenId(null); refetch().catch(() => {}); }}
          onChanged={() => { refetch().catch(() => {}); }}
          onCreated={() => {}}
        />
      )}
    </section>
  );
}
