import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Loader } from "@/components/loader";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { AD_STAGE_WORDS, adStage, type AdStage } from "@/lib/ad-upload";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./pipeline.css";
import "./scheduling.css";
import "./ad-uploads.css";

// Ad uploads — for the Managers and Team Leads: every approved Ad task, by
// team (each team is a brand), waiting for the ads it became to be recorded —
// the AD number from Animus for the VSL team, or the names the other teams send
// back. Recording happens in the task window's Ad uploads part. Data: GET
// /ad-uploads (server/src/routes/ad-uploads.js).

type Row = Task & { ad_refs: string[] };
const TABS: { key: AdStage; color: string; empty: string }[] = [
  { key: "to_upload", color: "oklch(0.72 0.15 65)", empty: "Nothing waiting. Approved ads arrive here for their ad numbers." },
  { key: "uploaded", color: "oklch(0.58 0.12 185)", empty: "Nothing recorded in the last 60 days yet." },
];
const shortDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");

export function AdUploadsPage() {
  const { editors } = useEditors();
  const { active, workspaces } = useWorkspaces();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AdStage>("to_upload");
  const [brand, setBrand] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRows((await api<{ tasks: Row[] }>("/ad-uploads")).tasks);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load Ad uploads.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const staged = useMemo(() => (rows ?? []).map((t) => ({ t, stage: adStage(t) ?? "to_upload" })), [rows]);
  // the teams (brands) with work here, for the chips
  const brands = useMemo(() => [...new Map((rows ?? []).filter((t) => t.channel_id).map((t) => [t.channel_id!, t.channel_name ?? "Brand"])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const inBrand = staged.filter((x) => brand === "all" || x.t.channel_id === brand);
  const count = (k: AdStage) => inBrand.filter((x) => x.stage === k).length;
  const shown = inBrand.filter((x) => x.stage === tab).map((x) => x.t);
  const edOf = (id: string | null) => (editors ?? []).find((e) => e.id === id) ?? null;
  const openTask = openId ? (rows ?? []).find((t) => t.id === openId) ?? null : null;
  const color = TABS.find((x) => x.key === tab)!.color;
  // the open task's tab follows it: record its ads and the list goes with it to Uploaded
  const openStage = openTask ? adStage(openTask) ?? "to_upload" : null;
  useEffect(() => { if (openStage) setTab(openStage); }, [openStage]);

  if (error) return <section className="screen pp"><div className="pp-card sch-empty">{error}</div></section>;
  if (!rows) return <section className="screen"><Loader label="Loading…" /></section>;
  return (
    <section className="screen pp sch-page adu-page">
      <div className="pp-top">
        <div className="pp-title">
          <h1>Ad uploads</h1>
          <span>Approved ads, by team. Once one is uploaded, record its ad numbers in the task.</span>
        </div>
        <span className="pp-grow" />
        <div className="pp-seg" role="tablist" aria-label="Stage">
          {TABS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>
              <i className="sch-dot" style={{ background: x.color }} />{AD_STAGE_WORDS[x.key]}<span className="pp-n">{count(x.key)}</span>
            </button>
          ))}
        </div>
      </div>

      {brands.length > 1 && (
        <div className="adu-brands" role="group" aria-label="Team">
          {[["all", "All teams"] as [string, string], ...brands].map(([id, name]) => (
            <button key={id} type="button" className={brand === id ? "on" : ""} aria-pressed={brand === id} onClick={() => setBrand(id)}>{name}</button>
          ))}
        </div>
      )}

      <section className="pp-card pp-table">
        <div className="pp-scroll"><div className="pp-grid">
          <div className="pp-th"><span>Task</span><span>AID</span><span>Team</span><span>Editor</span><span>Approved</span><span>Ads</span><span className="r" /></div>
          {shown.length === 0 && <div className="sch-empty">{TABS.find((x) => x.key === tab)!.empty}</div>}
          {shown.map((t) => {
            const ed = edOf(t.editor_id);
            return (
              <div key={t.id} className="pp-tr" role="button" tabIndex={0} style={{ ["--tc" as string]: color }}
                onClick={() => setOpenId(t.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
                <span className="pp-cell-title">
                  <b>{t.title}</b>
                  <span>
                    {t.content_format_name && <em className="pp-type">{t.content_format_name.toUpperCase()}</em>}
                    {t.delivery_link && (
                      <a className="sch-work" href={t.delivery_link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open the work ↗</a>
                    )}
                  </span>
                </span>
                <span>{t.ad_id ? <span className="pp-ref">{t.ad_id}</span> : <span className="pp-faint">—</span>}</span>
                <span className="sch-brand">{t.channel_name ?? "—"}</span>
                <span className="pp-ed">
                  <span className="pp-ava" style={{ width: 24, height: 24, background: gradFor(ed?.name ?? t.editor_name ?? "?") }}>{initialsOf(ed?.name ?? t.editor_name ?? "?")}</span>
                  <b>{ed?.name ?? t.editor_name ?? "—"}</b>
                </span>
                <span className="pp-faint">{shortDay(t.completed_at)}</span>
                <span className="adu-refs">{t.ad_refs.length ? t.ad_refs.join(", ") : <span className="pp-faint">—</span>}</span>
                <span className="sch-act">
                  <button type="button" className="sch-btn" onClick={(e) => { e.stopPropagation(); setOpenId(t.id); }}>{tab === "to_upload" ? "Add ads" : "View"}</button>
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
