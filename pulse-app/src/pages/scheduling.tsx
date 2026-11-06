import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Loader } from "@/components/loader";
import { Icon } from "@/components/icon";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { STAGE_WORDS, clockWords, dayWords, leftTone, leftWords, linksDueAt, scheduleStage, useNow, type SchedStage } from "@/lib/schedule";
import { TaskPanel } from "@/pages/tasks";
import { pieceLabel } from "@/lib/job-count";
import type { Task } from "@/lib/types";
import "./pipeline.css";
import "./scheduling.css";

// Scheduling — for this month's schedulers (anyone with a Schedule goal) and
// the Managers and Team Leads: every approved reel, carousel and post, in one shared list. Setting a
// task's post date takes it (it leaves the others' list); once it's up, its
// links go in the task window's Scheduling part — two days for them, counted
// down beside the date — and each becomes a post on the same SID. Data: GET /scheduling (server/src/routes/scheduling.js).

// today: what each scheduler scheduled today (a post date first set today), by brand —
// everyone's for the Managers and Team Leads, else your own
type Today = { editorId: string; name: string; total: number; brands: { brandId: string | null; brand: string; n: number }[] };
type Data = { tasks: Task[]; me: string | null; lead: boolean; scheduler: boolean; today?: Today[] };
// the Brand filter is each viewer's own, kept in this browser
const BRAND_KEY = "echo.scheduling.brand";
const readBrand = () => { try { return localStorage.getItem(BRAND_KEY) ?? ""; } catch { return ""; } };
const keepBrand = (v: string) => { try { if (v) localStorage.setItem(BRAND_KEY, v); else localStorage.removeItem(BRAND_KEY); } catch { /* private window */ } };
const TABS: { key: SchedStage; color: string; empty: string }[] = [
  { key: "to_schedule", color: "oklch(0.72 0.15 65)", empty: "Nothing waiting. Approved reels, carousels and posts arrive here." },
  { key: "scheduled", color: "oklch(0.62 0.13 230)", empty: "Nothing scheduled ahead. Set a post date on one waiting to be scheduled." },
  { key: "links_due", color: "oklch(0.62 0.19 25)", empty: "No links due. From its post day, a post waits here for its links: two days to paste them." },
  { key: "live", color: "oklch(0.58 0.12 185)", empty: "Nothing live in the last 60 days yet." },
];
const ACTION: Record<SchedStage, string> = { to_schedule: "Set date", scheduled: "Open", links_due: "Add links", live: "View" };
const shortDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");

export function SchedulingPage() {
  const { editors } = useEditors();
  const { active, workspaces } = useWorkspaces();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SchedStage>("to_schedule");
  const [openId, setOpenId] = useState<string | null>(null);
  const [brand, setBrandState] = useState(readBrand);
  const setBrand = (v: string) => { setBrandState(v); keepBrand(v); };
  const load = useCallback(async () => {
    try {
      setData(await api<Data>("/scheduling"));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load the scheduling list.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // the brands in the list, for its filter; a brand no longer in it shows everything
  const brands = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.tasks ?? []) if (t.channel_id) m.set(t.channel_id, t.channel_name ?? "—");
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);
  const brandOn = brand && brands.some((b) => b.id === brand) ? brand : "";
  const staged = useMemo(() => (data?.tasks ?? []).filter((t) => !brandOn || t.channel_id === brandOn)
    .map((t) => ({ t, stage: scheduleStage(t) ?? "to_schedule" })), [data, brandOn]);
  const count = (k: SchedStage) => staged.filter((x) => x.stage === k).length;
  const rows = staged.filter((x) => x.stage === tab).map((x) => x.t);
  const edOf = (id: string | null) => (editors ?? []).find((e) => e.id === id) ?? null;
  const openTask = openId ? (data?.tasks ?? []).find((t) => t.id === openId) ?? null : null;
  const color = TABS.find((x) => x.key === tab)!.color;
  const now = useNow();
  // the open task's tab follows it: set its date and the list goes with it to
  // Scheduled (or Waiting for links), so closing the window shows it there
  const openStage = openTask ? scheduleStage(openTask) ?? "to_schedule" : null;
  useEffect(() => { if (openStage) setTab(openStage); }, [openStage]);

  if (error) return <section className="screen pp"><div className="pp-card sch-empty">{error}</div></section>;
  if (!data) return <section className="screen"><Loader label="Loading…" /></section>;
  return (
    <section className="screen pp sch-page">
      <div className="pp-top">
        <div className="pp-title">
          <h1>Scheduling</h1>
          <span>{data.lead && !data.scheduler ? "Everyone's scheduling, for the Managers and Team Leads." : "Set a post date to take one. Once it's up, paste its links in the task."}</span>
        </div>
        <span className="pp-grow" />
        {brands.length > 1 && (
          <label className="pp-select">
            <select value={brandOn} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
              <option value="">All brands</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <Icon name="expand_more" size={18} />
          </label>
        )}
        <div className="pp-seg" role="tablist" aria-label="Stage">
          {TABS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>
              <i className="sch-dot" style={{ background: x.color }} />{STAGE_WORDS[x.key]}<span className="pp-n">{count(x.key)}</span>
            </button>
          ))}
        </div>
      </div>

      {data.today && (data.scheduler || data.lead) && (() => {
        // today's scheduling, by brand: the Brand filter keeps to its brand
        const people = data.today.map((p) => {
          const bs = brandOn ? p.brands.filter((b) => b.brandId === brandOn) : p.brands;
          return { ...p, brands: bs, total: bs.reduce((n, b) => n + b.n, 0) };
        }).filter((p) => p.total > 0);
        const mineOnly = !data.lead;
        return (
          <section className="pp-card sch-today" aria-label="Scheduled today">
            <b className="sch-today-h">Scheduled today</b>
            {people.length === 0 ? (
              <span className="pp-faint">{mineOnly ? "Nothing yet. Each post you set a date on today counts here." : "Nothing yet. Each post given a date today counts here, by scheduler and brand."}</span>
            ) : people.map((p) => (
              <span key={p.editorId} className="sch-today-p">
                <span className="pp-ava" style={{ width: 22, height: 22, background: gradFor(p.name) }}>{initialsOf(p.name)}</span>
                <b>{p.editorId === data.me ? "You" : p.name}</b>
                <span className="sch-today-n">{p.total}</span>
                <span className="sch-today-b">{p.brands.map((b) => `${b.brand} ${b.n}`).join(" · ")}</span>
              </span>
            ))}
          </section>
        );
      })()}

      <section className="pp-card pp-table">
        <div className="pp-scroll"><div className="pp-grid">
          <div className="pp-th"><span>Task</span><span>SID</span><span>Brand</span><span>Editor</span><span>Approved</span><span>Post on</span><span className="r">{tab === "to_schedule" ? "" : "Scheduler"}</span></div>
          {rows.length === 0 && <div className="sch-empty">{TABS.find((x) => x.key === tab)!.empty}</div>}
          {rows.map((t) => {
            const ed = edOf(t.editor_id);
            return (
              <div key={t.id} className="pp-tr" role="button" tabIndex={0} style={{ ["--tc" as string]: color }}
                onClick={() => setOpenId(t.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
                <span className="pp-cell-title">
                  <b>{t.title}</b>
                  <span>
                    {t.content_format_name && <em className="pp-type">{t.content_format_name.toUpperCase()}</em>}
                    {pieceLabel(t.meta) && <em className="pp-type" title="Bulk work: its first post; the others are their own rows">{pieceLabel(t.meta)}</em>}
                    {t.delivery_link && (
                      <a className="sch-work" href={t.delivery_link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open the work ↗</a>
                    )}
                  </span>
                </span>
                <span>{t.sid ? <span className="pp-ref">{t.sid}</span> : <span className="pp-faint">—</span>}</span>
                <span className="sch-brand">{t.channel_name ?? "—"}</span>
                <span className="pp-ed">
                  <span className="pp-ava" style={{ width: 24, height: 24, background: gradFor(ed?.name ?? t.editor_name ?? "?") }}>{initialsOf(ed?.name ?? t.editor_name ?? "?")}</span>
                  <b>{ed?.name ?? t.editor_name ?? "—"}</b>
                </span>
                <span className="pp-faint">{shortDay(t.completed_at)}</span>
                <span className="sch-on">
                  {t.post_on ? <span>{dayWords(t.post_on)}{t.post_time ? <small className="pp-faint"> · {clockWords(t.post_time)}</small> : null}</span> : <span className="pp-faint">—</span>}
                  {t.post_on && (tab === "scheduled" || tab === "links_due") && (() => {
                    const left = linksDueAt(t.post_on).getTime() - now;
                    return <small className={"sch-left " + leftTone(left)}>Links {leftWords(left)}</small>;
                  })()}
                </span>
                <span className="sch-act">
                  {tab !== "to_schedule" && <span className="pp-faint">{t.scheduler_id === data.me ? "You" : t.scheduler_name ?? "Not taken"}</span>}
                  <button type="button" className="sch-btn" onClick={(e) => { e.stopPropagation(); setOpenId(t.id); }}>{ACTION[tab]}</button>
                </span>
              </div>
            );
          })}
        </div></div>
      </section>

      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite={active?.role !== "viewer"} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => { setOpenId(null); load(); }}
          onChanged={() => { load(); }}
          onCreated={() => {}}
        />
      )}
    </section>
  );
}
