import { useMemo, useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import { formatScore } from "@/lib/score";
import { RANGE_PRESETS, rangeFor, inRange, labelFor, type RangeKey } from "@/lib/date-range";
import type { Post, Platform } from "@/lib/types";

type P = Post & { channel_id?: string; channel_name?: string };

const PLATFORM_ICON: Record<string, string> = { instagram: "📸", facebook: "👍", youtube: "▶️" };
const STATUS_OPTS: Array<[string, string]> = [["planned", "🕓 Planned"], ["published", "✅ Published"]];
const TYPE_OPTS: Array<[string, string]> = [["reel", "🎬 Reels"], ["carousel", "🖼️ Carousels"]];

// ---- Customizable table columns ----
type ColKey =
  | "date" | "channel" | "title" | "editor" | "pillar" | "type" | "avatar" | "link"
  | "collab" | "views" | "likes" | "comments" | "shares" | "saves" | "reach" | "score" | "status" | "source";
const COLUMNS: { key: ColKey; label: string; num?: boolean }[] = [
  { key: "date", label: "Date" },
  { key: "channel", label: "Channel" },
  { key: "title", label: "Title / Format" },
  { key: "editor", label: "Editor" },
  { key: "pillar", label: "Pillar" },
  { key: "type", label: "Type" },
  { key: "avatar", label: "Avatar" },
  { key: "link", label: "Link" },
  { key: "collab", label: "Collab" },
  { key: "views", label: "Views", num: true },
  { key: "likes", label: "Likes", num: true },
  { key: "comments", label: "Comments", num: true },
  { key: "shares", label: "Shares", num: true },
  { key: "saves", label: "Saves", num: true },
  { key: "reach", label: "Reach", num: true },
  { key: "score", label: "Score", num: true },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
];
const COL_META = Object.fromEntries(COLUMNS.map((c) => [c.key, c])) as Record<ColKey, { key: ColKey; label: string; num?: boolean }>;
const DEFAULT_VISIBLE: ColKey[] = ["date", "channel", "title", "editor", "pillar", "type", "views", "saves", "score", "status"];
const COLS_STORAGE_KEY = "pulse:postsColumns";

type ColCfg = { key: ColKey; visible: boolean };
function defaultCols(): ColCfg[] {
  const vis = new Set(DEFAULT_VISIBLE);
  return COLUMNS.map((c) => ({ key: c.key, visible: vis.has(c.key) }));
}
// Load saved config, tolerating added/removed columns across versions.
function loadCols(): ColCfg[] {
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as ColCfg[];
      const known = new Set(COLUMNS.map((c) => c.key));
      const seen = new Set(saved.map((s) => s.key));
      const merged = saved.filter((s) => known.has(s.key));
      for (const c of COLUMNS) if (!seen.has(c.key)) merged.push({ key: c.key, visible: false });
      return merged;
    }
  } catch { /* ignore malformed storage */ }
  return defaultCols();
}

function fmtNum(n: number) {
  return n > 0 ? n.toLocaleString() : "—";
}
// Toggle a value in a Set (immutably).
function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, val: T) {
  setter((s) => {
    const n = new Set(s);
    n.has(val) ? n.delete(val) : n.add(val);
    return n;
  });
}

type Opt = { value: string; label: string; count?: number };

// A compact multi-select dropdown: a labelled button that opens a checkbox
// menu. Closes on outside click. Selecting multiple options is OR within it.
function MultiSelect({ label, options, selected, onToggle }: {
  label: string; options: Opt[]; selected: Set<string>; onToggle: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const n = selected.size;
  return (
    <div className="msel" ref={ref}>
      <button className={"msel-btn" + (n ? " on" : "")} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        {n > 0 && <span className="msel-count">{n}</span>}
        <span className="msel-cv">▾</span>
      </button>
      {open && (
        <div className="msel-menu">
          {options.length === 0 ? (
            <div className="msel-empty">No options</div>
          ) : options.map((o) => (
            <label key={o.value} className={"msel-opt" + (selected.has(o.value) ? " sel" : "")}>
              <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(o.value)} />
              <span className="msel-opt-l">{o.label}</span>
              {o.count !== undefined && <span className="msel-opt-n">{o.count}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function PostsPage() {
  const { taxonomy } = useTaxonomy();
  const { editors } = useEditors();
  const { workspaces } = useWorkspaces();
  const navigate = useNavigate();
  const location = useLocation();

  // Cross-channel content database so Channel / Platform / Collab filters work.
  const { data: postData, refetch } = useResource<{ posts: P[] }>("/posts?channel=all");
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const posts = postData?.posts ?? null;

  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [platformIds, setPlatformIds] = useState<Set<string>>(new Set());
  const [collabsOnly, setCollabsOnly] = useState(false);

  // Date-range filter.
  const [range, setRange] = useState<RangeKey>("all");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [popOpen, setPopOpen] = useState(false);
  const monthStart = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; })();
  const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const [fromInput, setFromInput] = useState(monthStart);
  const [toInput, setToInput] = useState(todayStr);
  const bounds = range === "custom" && custom ? custom : rangeFor(range);
  const rangeLabel = range === "custom" ? "Custom" : labelFor(range);
  function applyCustom() { setCustom({ from: fromInput, to: toInput }); setRange("custom"); setPopOpen(false); }

  const name = (list: { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? "—";
  const pillarName = (id: string) => name(taxonomy?.pillars, id);
  const avatarName = (id: string) => name(taxonomy?.avatars, id);
  const formatName = (id: string) => name(taxonomy?.formats, id);
  const editorName = (id: string | null) => (id ? editors?.find((e) => e.id === id)?.name ?? "—" : "—");
  const channelName = (id: string | null | undefined) => (id ? workspaces.find((w) => w.id === id)?.name ?? "—" : "—");
  const platformKey = (id: string | null) => (id ? platData?.platforms.find((p) => p.id === id)?.key : undefined);

  // Posts in the selected date window — counts + all categorical filters apply on top.
  const scoped = useMemo(
    () => (posts ?? []).filter((p) => inRange(p.date, bounds.from, bounds.to)),
    [posts, bounds.from, bounds.to],
  );

  // Per-option counts (within the date window) so users see what's available.
  const counts = useMemo(() => {
    const c = { status: {} as Record<string, number>, type: {} as Record<string, number>,
      channel: {} as Record<string, number>, platform: {} as Record<string, number>, collab: 0 };
    for (const p of scoped) {
      c.status[p.status] = (c.status[p.status] ?? 0) + 1;
      if (p.post_type) c.type[p.post_type] = (c.type[p.post_type] ?? 0) + 1;
      if (p.channel_id) c.channel[p.channel_id] = (c.channel[p.channel_id] ?? 0) + 1;
      if (p.platform_id) c.platform[p.platform_id] = (c.platform[p.platform_id] ?? 0) + 1;
      if (p.collab_channel_id) c.collab += 1;
    }
    return c;
  }, [scoped]);

  // Dropdown option lists (with counts). Platform + Channel always list ALL
  // options so you can filter even before there's data for them.
  const statusOptions: Opt[] = STATUS_OPTS.map(([v, l]) => ({ value: v, label: l, count: counts.status[v] ?? 0 }));
  const typeOptions: Opt[] = TYPE_OPTS.map(([v, l]) => ({ value: v, label: l, count: counts.type[v] ?? 0 }));
  const platformOptions: Opt[] = (platData?.platforms ?? []).map((pf) => ({
    value: pf.id, label: (PLATFORM_ICON[pf.key] ?? "📱") + " " + pf.name, count: counts.platform[pf.id] ?? 0,
  }));
  const channelOptions: Opt[] = workspaces.map((w) => ({ value: w.id, label: w.name, count: counts.channel[w.id] ?? 0 }));

  const rows = useMemo(() => {
    return scoped.filter((p) => {
      if (statuses.size && !statuses.has(p.status)) return false;
      if (types.size && !types.has(p.post_type)) return false;
      if (channelIds.size && !(p.channel_id && channelIds.has(p.channel_id))) return false;
      if (platformIds.size && !(p.platform_id && platformIds.has(p.platform_id))) return false;
      if (collabsOnly && !p.collab_channel_id) return false;
      if (query) {
        const hay = (p.title + " " + formatName(p.format_id) + " " + (p.channel_name ?? "")).toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, statuses, types, channelIds, platformIds, collabsOnly, query, taxonomy]);

  const activeCount =
    statuses.size + types.size + channelIds.size + platformIds.size +
    (collabsOnly ? 1 : 0) + (range !== "all" ? 1 : 0) + (query ? 1 : 0);

  function clearAll() {
    setStatuses(new Set()); setTypes(new Set()); setChannelIds(new Set());
    setPlatformIds(new Set()); setCollabsOnly(false); setRange("all"); setQuery("");
  }

  async function handleDelete(e: React.MouseEvent, post: P) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${post.title}"? This can't be undone.`)) return;
    try {
      await api(`/posts/${post.id}`, { method: "DELETE" });
      await refetch();
      toast.success("Post deleted.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete post.");
    }
  }

  // Customizable columns (persisted per browser).
  const [cols, setCols] = useState<ColCfg[]>(loadCols);
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols)); }, [cols]);
  useEffect(() => {
    if (!colsOpen) return;
    const onDoc = (e: MouseEvent) => { if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [colsOpen]);
  const visibleCols = cols.filter((c) => c.visible);
  const toggleCol = (k: ColKey) => setCols((cs) => cs.map((c) => (c.key === k ? { ...c, visible: !c.visible } : c)));
  const moveCol = (i: number, dir: number) => setCols((cs) => {
    const j = i + dir;
    if (j < 0 || j >= cs.length) return cs;
    const n = [...cs]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  function renderCell(key: ColKey, p: P) {
    switch (key) {
      case "date": return p.date;
      case "channel": return (
        <span className="ch-cell">
          <span className="ch-ic">{PLATFORM_ICON[platformKey(p.platform_id) ?? ""] ?? "📱"}</span>
          {p.channel_name ?? channelName(p.channel_id)}
        </span>
      );
      case "title": return (
        <>
          <b style={{ fontWeight: 650 }}>
            {p.title}
            {p.collab_channel_id && <span className="collab-badge" title={`Collab with ${channelName(p.collab_channel_id)}`}>🤝</span>}
          </b>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{formatName(p.format_id)}</div>
        </>
      );
      case "editor": return editorName(p.editor_id);
      case "pillar": return <span className="tag">{pillarName(p.pillar_id)}</span>;
      case "type": return p.post_type === "reel" ? "Reel" : "Carousel";
      case "avatar": return <span className="tag av">{avatarName(p.avatar_id)}</span>;
      case "link": return p.permalink
        ? <a href={p.permalink} target="_blank" rel="noreferrer" className="tlink" onClick={(e) => e.stopPropagation()}>↗ Open</a>
        : "—";
      case "collab": return p.collab_channel_id ? channelName(p.collab_channel_id) : "—";
      case "views": return fmtNum(p.views);
      case "likes": return fmtNum(p.likes);
      case "comments": return fmtNum(p.comments);
      case "shares": return fmtNum(p.shares);
      case "saves": return fmtNum(p.saves);
      case "reach": return fmtNum(p.reach);
      case "score": return <b>{formatScore(p)}</b>;
      case "status": return p.status === "planned"
        ? <span className="stbadge st-planned">🕓 Planned</span>
        : <span className="stbadge st-pub">✅ Published</span>;
      case "source": return <span className={"src " + (p.source === "instagram" ? "ig" : "man")}>{p.source === "instagram" ? "⚡ IG" : "✍️ Manual"}</span>;
      default: return null;
    }
  }

  return (
    <section className="screen">
      {/* Search + date range + clear */}
      <div className="toolbar">
        <div className="search">
          <span>🔎</span>
          <input placeholder="Search title, format, channel…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div style={{ marginLeft: "auto", position: "relative" }}>
          <button className="rangebtn" onClick={() => setPopOpen((o) => !o)}>
            <span>🗓️ {rangeLabel}</span><span className="cv">▾</span>
          </button>
          <div className={"rangepop" + (popOpen ? " show" : "")} onClick={(e) => e.stopPropagation()}>
            <div className="rangepresets">
              {RANGE_PRESETS.map(([k, label]) => (
                <button key={k} className={"rp" + (range === k ? " on" : "")} onClick={() => { setRange(k); setPopOpen(false); }}>{label}</button>
              ))}
            </div>
            <div className="rpcustom">
              <h5>Custom range</h5>
              <div><label>From</label><input type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} /></div>
              <div><label>To</label><input type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} /></div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "auto" }}>
                <button className="btn" onClick={() => setPopOpen(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={applyCustom}>Apply</button>
              </div>
            </div>
          </div>
        </div>
        {activeCount > 0 && <button className="btn" onClick={clearAll}>✕ Clear ({activeCount})</button>}
        <div className="msel" ref={colsRef}>
          <button className="btn" onClick={() => setColsOpen((o) => !o)}>＋ Columns</button>
          {colsOpen && (
            <div className="msel-menu cols-menu">
              <div className="cols-head">
                <b>Customize columns</b>
                <button className="cols-reset" onClick={() => setCols(defaultCols())}>Reset</button>
              </div>
              {cols.map((c, i) => (
                <div key={c.key} className="cols-row">
                  <label className="cols-check">
                    <input type="checkbox" checked={c.visible} onChange={() => toggleCol(c.key)} />
                    <span>{COL_META[c.key].label}</span>
                  </label>
                  <span className="cols-move">
                    <button title="Move up" disabled={i === 0} onClick={() => moveCol(i, -1)}>↑</button>
                    <button title="Move down" disabled={i === cols.length - 1} onClick={() => moveCol(i, 1)}>↓</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="btn" disabled>⬇ Export CSV</button>
      </div>

      {/* Combinable dropdown filters */}
      <div className="filterbar-d">
        <MultiSelect label="Status" options={statusOptions} selected={statuses} onToggle={(v) => toggleSet(setStatuses, v)} />
        <MultiSelect label="Format" options={typeOptions} selected={types} onToggle={(v) => toggleSet(setTypes, v)} />
        <MultiSelect label="Platform" options={platformOptions} selected={platformIds} onToggle={(v) => toggleSet(setPlatformIds, v)} />
        <MultiSelect label="Channel" options={channelOptions} selected={channelIds} onToggle={(v) => toggleSet(setChannelIds, v)} />
        <button className={"msel-btn" + (collabsOnly ? " on" : "")} onClick={() => setCollabsOnly((v) => !v)}>
          <span>🤝 Collabs only</span>
          <span className="msel-count">{counts.collab}</span>
        </button>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              {visibleCols.map((c) => <th key={c.key} className={COL_META[c.key].num ? "num" : undefined}>{COL_META[c.key].label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {posts === null ? (
              <tr><td colSpan={visibleCols.length + 1} style={{ textAlign: "center", padding: 26, color: "var(--muted)" }}>Loading…</td></tr>
            ) : visibleCols.length === 0 ? (
              <tr><td colSpan={1} style={{ textAlign: "center", padding: 26, color: "var(--muted)" }}>All columns hidden — add some from ＋ Columns.</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={visibleCols.length + 1} style={{ textAlign: "center", padding: 26, color: "var(--muted)" }}>No posts match these filters.</td></tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} className="clickrow" onClick={() => navigate(`/posts/${p.id}/edit`, { state: { backgroundLocation: location } })}>
                  {visibleCols.map((c) => (
                    <td key={c.key} className={COL_META[c.key].num ? "num" : undefined}>{renderCell(c.key, p)}</td>
                  ))}
                  <td>
                    <button className="rowbtn" title="Delete post" onClick={(e) => handleDelete(e, p)}>🗑</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {posts && (
        <div className="hint" style={{ marginTop: 12 }}>
          Showing <b style={{ color: "var(--text)" }}>{rows.length}</b> of {posts.length}
          {range !== "all" && <> · {rangeLabel}</>}
          {activeCount > 0 && <> · {activeCount} filter{activeCount === 1 ? "" : "s"} active</>}
        </div>
      )}
    </section>
  );
}
