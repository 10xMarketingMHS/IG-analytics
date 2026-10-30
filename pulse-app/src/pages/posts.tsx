import { useMemo, useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import { formatScore } from "@/lib/score";
import { MultiSelect, type Opt } from "@/components/multi-select";
import { rangeFor, inRange, labelFor, type RangeKey } from "@/lib/date-range";
import { channelTile, gradFor, initialsOf } from "@/lib/editor-visuals";
import { IC, PLATFORM_AB, PLATFORM_COLOR, RangePicker, shortDate } from "@/pages/analytics";
import type { Account, Post, Platform } from "@/lib/types";
import "./analytics.css";
import "./posts.css";

type P = Post & { channel_id?: string; channel_name?: string };

// The Analytics design (analytics.css, posts.css): status as tabs, the other
// filters beside them, the table in one panel. Nothing lifts on hover.
type Status = "all" | "planned" | "published";
const STATUS_TABS: [Status, string, React.ReactNode][] = [["all", "All posts", IC.grid], ["planned", "Planned", IC.clock], ["published", "Published", IC.upload]];
const TYPE_OPTS: Array<[string, string]> = [["reel", "Reels"], ["carousel", "Carousels"]];
const longDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

// ---- Customizable table columns ----
type ColKey =
  | "date" | "channel" | "platform" | "title" | "editor" | "pillar" | "type" | "avatar" | "link"
  | "collab" | "views" | "likes" | "comments" | "shares" | "saves" | "reach" | "score" | "status" | "source";
const COLUMNS: { key: ColKey; label: string; num?: boolean }[] = [
  { key: "date", label: "Date" },
  { key: "channel", label: "Channel" },
  { key: "platform", label: "Platform" },
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
const DEFAULT_VISIBLE: ColKey[] = ["date", "channel", "platform", "title", "editor", "pillar", "type", "views", "saves", "score", "status"];
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
      const merged = saved.filter((s) => known.has(s.key));
      // Columns added in a newer release aren't in the saved config. Insert each
      // at its natural position (right after its preceding column in COLUMNS)
      // rather than dumping it at the end, and adopt its default visibility — so
      // a new default-on column (e.g. Platform) lands next to Channel and is
      // actually seen, instead of appended off-screen or silently hidden.
      const vis = new Set(DEFAULT_VISIBLE);
      COLUMNS.forEach((c, ci) => {
        if (merged.some((m) => m.key === c.key)) return;
        let insertAt = merged.length;
        for (let k = ci - 1; k >= 0; k--) {
          const idx = merged.findIndex((m) => m.key === COLUMNS[k].key);
          if (idx >= 0) { insertAt = idx + 1; break; }
        }
        merged.splice(insertAt, 0, { key: c.key, visible: vis.has(c.key) });
      });
      return merged;
    }
  } catch { /* ignore malformed storage */ }
  return defaultCols();
}

function fmtNum(n: number) {
  return n > 0 ? n.toLocaleString() : <span className="pst-none">—</span>;
}
// Toggle a value in a Set (immutably).
function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, val: T) {
  setter((s) => {
    const n = new Set(s);
    n.has(val) ? n.delete(val) : n.add(val);
    return n;
  });
}

export function PostsPage() {
  const { taxonomy } = useTaxonomy();
  const { editors } = useEditors();
  const { workspaces, isAdmin } = useWorkspaces();
  const navigate = useNavigate();
  const location = useLocation();

  // Cross-channel content database so Channel / Platform / Collab filters work.
  const { data: postData, refetch } = useResource<{ posts: P[] }>("/posts?channel=all");
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  // each channel's platforms, as dots on its chip
  const { data: acctData } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const platformsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of acctData?.accounts ?? []) {
      if (!m.has(a.channel_id)) m.set(a.channel_id, new Set());
      m.get(a.channel_id)!.add(a.platform_key);
    }
    return m;
  }, [acctData]);
  const posts = postData?.posts ?? null;

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [types, setTypes] = useState<Set<string>>(new Set());
  // The channel chips (and a link that passes { channel }) filter to one channel.
  const [channelIds, setChannelIds] = useState<Set<string>>(() => {
    const ch = (location.state as { channel?: string } | null)?.channel;
    return new Set(ch ? [ch] : []);
  });
  const stateChannel = (location.state as { channel?: string } | null)?.channel;
  useEffect(() => { if (stateChannel) setChannelIds(new Set([stateChannel])); }, [stateChannel, location.key]);
  const [platformIds, setPlatformIds] = useState<Set<string>>(new Set());
  const [collabsOnly, setCollabsOnly] = useState(false);

  // Date-range filter.
  const [range, setRange] = useState<RangeKey>("all");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const bounds = range === "custom" && custom ? custom : rangeFor(range);
  const rangeLabel = range === "custom" ? "Custom range" : labelFor(range);
  // the picker shows the dates it covers; All time: the first post to the last
  const datesText = useMemo(() => {
    const ds = (posts ?? []).map((p) => p.date).filter(Boolean).sort();
    const from = bounds.from ?? ds[0], to = bounds.to ?? ds[ds.length - 1];
    if (!from || !to) return "Any date";
    return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  }, [posts, bounds.from, bounds.to]);

  const name = (list: { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? "—";
  const pillarName = (id: string) => name(taxonomy?.pillars, id);
  const avatarName = (id: string) => name(taxonomy?.avatars, id);
  const formatName = (id: string) => name(taxonomy?.formats, id);
  const channelName = (id: string | null | undefined) => (id ? workspaces.find((w) => w.id === id)?.name ?? "—" : "—");
  const platformOf = (id: string | null) => (id ? platData?.platforms.find((p) => p.id === id) : undefined);

  // Posts in the selected date window — counts + all categorical filters apply on top.
  const scoped = useMemo(
    () => (posts ?? []).filter((p) => inRange(p.date, bounds.from, bounds.to)),
    [posts, bounds.from, bounds.to],
  );

  // Per-option counts (within the date window) so users see what's available.
  const counts = useMemo(() => {
    const c = { type: {} as Record<string, number>,
      channel: {} as Record<string, number>, platform: {} as Record<string, number>, collab: 0 };
    for (const p of scoped) {
      if (p.post_type) c.type[p.post_type] = (c.type[p.post_type] ?? 0) + 1;
      if (p.channel_id) c.channel[p.channel_id] = (c.channel[p.channel_id] ?? 0) + 1;
      if (p.platform_id) c.platform[p.platform_id] = (c.platform[p.platform_id] ?? 0) + 1;
      if (p.collab_channel_id) c.collab += 1;
    }
    return c;
  }, [scoped]);

  // Dropdown option lists (with counts). Platform + Channel always list ALL
  // options so you can filter even before there's data for them.
  const typeOptions: Opt[] = TYPE_OPTS.map(([v, l]) => ({ value: v, label: l, count: counts.type[v] ?? 0 }));
  const platformOptions: Opt[] = (platData?.platforms ?? []).map((pf) => ({
    value: pf.id, label: pf.name, count: counts.platform[pf.id] ?? 0,
  }));
  const channelOptions: Opt[] = workspaces.map((w) => ({ value: w.id, label: w.name, count: counts.channel[w.id] ?? 0 }));

  // every filter but the status tab: the tabs count from this
  const base = useMemo(() => {
    return scoped.filter((p) => {
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
  }, [scoped, types, channelIds, platformIds, collabsOnly, query, taxonomy]);
  const rows = useMemo(() => (status === "all" ? base : base.filter((p) => p.status === status)), [base, status]);
  const tabCount = (k: Status) => (k === "all" ? base.length : base.filter((p) => p.status === k).length);

  const activeCount =
    (status !== "all" ? 1 : 0) + types.size + channelIds.size + platformIds.size +
    (collabsOnly ? 1 : 0) + (range !== "all" ? 1 : 0) + (query ? 1 : 0);

  function clearAll() {
    setStatus("all"); setTypes(new Set()); setChannelIds(new Set());
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
      case "date": return <span className="pst-date">{longDate(p.date)}</span>;
      case "channel": {
        const id = p.channel_id ?? "";
        const nm = p.channel_name ?? channelName(p.channel_id);
        return (
          <span className="pst-ch">
            <span className="pst-tile" style={{ background: channelTile(id) }}>{initialsOf(nm)}</span>
            {nm}
          </span>
        );
      }
      case "title": return (
        <span className="pst-title">
          <b>
            {p.title}
            {p.collab_channel_id && <span className="pst-collab" title={`Collab with ${channelName(p.collab_channel_id)}`}>Collab</span>}
          </b>
          <span>{formatName(p.format_id)}</span>
        </span>
      );
      case "platform": {
        const pf = platformOf(p.platform_id);
        if (!pf) return <span className="pst-none">—</span>;
        return (
          <span className="pst-ch">
            <span className="an-ptile" style={{ background: PLATFORM_COLOR[pf.key] ?? "var(--an-ac)" }}>{PLATFORM_AB[pf.key] ?? pf.name.slice(0, 2).toUpperCase()}</span>
            {pf.name}
          </span>
        );
      }
      case "editor": {
        const e = p.editor_id ? editors?.find((x) => x.id === p.editor_id) : undefined;
        if (!e) return <span className="pst-none">—</span>;
        return (
          <span className="an-ed">
            {e.image_url ? <img src={e.image_url} alt="" /> : <span style={{ background: gradFor(e.name) }}>{e.name.charAt(0).toUpperCase()}</span>}
            {e.name}
          </span>
        );
      }
      case "pillar": return <span className="pst-tag">{pillarName(p.pillar_id)}</span>;
      case "type": return p.post_type === "reel" ? "Reel" : "Carousel";
      case "avatar": return <span className="pst-tag alt">{avatarName(p.avatar_id)}</span>;
      case "link": return p.permalink
        ? <a href={p.permalink} target="_blank" rel="noreferrer" className="pst-link" onClick={(e) => e.stopPropagation()}>Open{IC.ext}</a>
        : <span className="pst-none">—</span>;
      case "collab": return p.collab_channel_id ? channelName(p.collab_channel_id) : <span className="pst-none">—</span>;
      case "views": return fmtNum(p.views);
      case "likes": return fmtNum(p.likes);
      case "comments": return fmtNum(p.comments);
      case "shares": return fmtNum(p.shares);
      case "saves": return fmtNum(p.saves);
      case "reach": return fmtNum(p.reach);
      case "score": return <b className="pst-score">{formatScore(p)}</b>;
      case "status": return p.status === "planned"
        ? <span className="pst-st planned"><i />Planned</span>
        : <span className="pst-st published"><i />Published</span>;
      case "source": return <span className="pst-tag alt">{p.source === "instagram" ? "Instagram" : "Manual"}</span>;
      default: return null;
    }
  }

  const openPost = (p: P) => navigate(`/posts/${p.id}/edit`, { state: { backgroundLocation: location } });
  const emptyRow = (text: string, span: number) => (
    <tr className="pst-empty"><td colSpan={span}>{text}</td></tr>
  );

  return (
    <section className="screen an pst">
      {/* The channels (they were in the sidebar): one click shows that channel's
          posts, again to show them all; the Channel filter below stays in step */}
      {workspaces.length > 0 && (
        <div className="pst-chans" role="group" aria-label="Channels">
          <button type="button" className={"pst-chan all" + (channelIds.size === 0 ? " on" : "")} aria-pressed={channelIds.size === 0}
            onClick={() => setChannelIds(new Set())}>
            All channels<span className="pst-count">{scoped.length}</span>
          </button>
          {workspaces.map((w) => {
            const on = channelIds.has(w.id);
            return (
              <button key={w.id} type="button" className={"pst-chan" + (on ? " on" : "")} aria-pressed={on} title={`${w.name}: see its posts`}
                onClick={() => setChannelIds(on && channelIds.size === 1 ? new Set() : new Set([w.id]))}>
                <span className="pst-tile" style={w.logo_url ? undefined : { background: channelTile(w.id) }}>
                  {w.logo_url ? <img src={w.logo_url} alt="" /> : initialsOf(w.name)}
                </span>
                {w.name}
                <span className="pst-chan-plats" aria-hidden="true">
                  {[...(platformsOf.get(w.id) ?? [])].map((k) => <i key={k} style={{ background: PLATFORM_COLOR[k] ?? "currentColor" }} />)}
                </span>
                <span className="pst-count">{counts.channel[w.id] ?? 0}</span>
              </button>
            );
          })}
          {isAdmin && <button type="button" className="pst-chan-edit" onClick={() => navigate("/channels")}>Edit channels</button>}
        </div>
      )}

      {/* Search, dates, columns */}
      <div className="an-bar">
        <label className="pst-search">
          {IC.search}
          <input placeholder="Search title, format, channel…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button type="button" className="pst-x" onClick={() => setQuery("")} aria-label="Clear the search">{IC.x}</button>}
        </label>
        <RangePicker range={range} label={rangeLabel} dates={datesText} onPick={(k) => setRange(k)}
          onCustom={(f, t) => { setCustom({ from: f, to: t }); setRange("custom"); }} />
        {activeCount > 0 && <button type="button" className="an-btn" onClick={clearAll}>{IC.x}Clear ({activeCount})</button>}
        <div className="pst-menuwrap" ref={colsRef}>
          <button type="button" className="an-btn" onClick={() => setColsOpen((o) => !o)} aria-expanded={colsOpen}>{IC.columns}Columns</button>
          {colsOpen && (
            <div className="pst-menu">
              <div className="pst-menuhead">
                <b>Customize columns</b>
                <button type="button" onClick={() => setCols(defaultCols())}>Reset</button>
              </div>
              {cols.map((c, i) => (
                <div key={c.key} className="pst-colrow">
                  <label>
                    <input type="checkbox" checked={c.visible} onChange={() => toggleCol(c.key)} />
                    <span>{COL_META[c.key].label}</span>
                  </label>
                  <span className="pst-move">
                    <button type="button" title="Move up" disabled={i === 0} onClick={() => moveCol(i, -1)}>↑</button>
                    <button type="button" title="Move down" disabled={i === cols.length - 1} onClick={() => moveCol(i, 1)}>↓</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="an-btn" disabled>{IC.download}Export CSV</button>
      </div>

      {/* Status tabs, then the other filters (combinable) */}
      <div className="an-tabsrow">
        <div className="an-tabs" role="tablist" aria-label="Status">
          {STATUS_TABS.map(([k, label, icon]) => (
            <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? "on" : ""} onClick={() => setStatus(k)}>
              {icon}{label}<span className="pst-count">{tabCount(k)}</span>
            </button>
          ))}
        </div>
        <span className="an-grow" />
        <div className="pst-filters">
          <MultiSelect label="Format" options={typeOptions} selected={types} onToggle={(v) => toggleSet(setTypes, v)} />
          <MultiSelect label="Platform" options={platformOptions} selected={platformIds} onToggle={(v) => toggleSet(setPlatformIds, v)} />
          <MultiSelect label="Channel" options={channelOptions} selected={channelIds} onToggle={(v) => toggleSet(setChannelIds, v)} />
          <button type="button" className={"msel-btn" + (collabsOnly ? " on" : "")} aria-pressed={collabsOnly} onClick={() => setCollabsOnly((v) => !v)}>
            {IC.users}<span>Collabs only</span>
            <span className="msel-count">{counts.collab}</span>
          </button>
        </div>
      </div>

      <section className="an-card an-flush">
        <div className="pst-head">
          <div className="an-hd">
            <b className="an-h">Posts</b>
            <span>
              {posts ? <>Showing {rows.length} of {posts.length}</> : "Loading…"}
              {range !== "all" && <> · {rangeLabel}</>}
              {activeCount > 0 && <> · {activeCount} filter{activeCount === 1 ? "" : "s"} on</>}
            </span>
          </div>
        </div>
        <div className="an-tablewrap">
          <table className="pst-table">
            <thead>
              <tr>
                {visibleCols.map((c) => <th key={c.key} className={COL_META[c.key].num ? "num" : undefined}>{COL_META[c.key].label}</th>)}
                <th aria-label="Delete" />
              </tr>
            </thead>
            <tbody>
              {posts === null ? emptyRow("Loading…", visibleCols.length + 1)
                : visibleCols.length === 0 ? emptyRow("All columns are hidden. Add some from Columns.", 1)
                : rows.length === 0 ? emptyRow("No posts match these filters.", visibleCols.length + 1)
                : rows.map((p) => (
                  <tr key={p.id} className="pst-row" tabIndex={0} onClick={() => openPost(p)}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openPost(p); }}>
                    {visibleCols.map((c) => (
                      <td key={c.key} className={COL_META[c.key].num ? "num" : undefined}>{renderCell(c.key, p)}</td>
                    ))}
                    <td className="pst-act">
                      <button type="button" className="pst-del" title="Delete post" aria-label={`Delete ${p.title}`} onClick={(e) => handleDelete(e, p)}>{IC.trash}</button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
