import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Loader } from "@/components/loader";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { STAGE_WORDS, clockWords, dayWords, scheduleStage, type SchedStage } from "@/lib/schedule";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./pipeline.css";
import "./scheduling.css";

// Scheduling — for this month's schedulers (anyone with a Schedule goal) and
// admins: every approved reel, carousel and post, in one shared list. Setting a
// task's post date takes it (it leaves the others' list); once it's up, its
// links go in the task window's Scheduling part, and each becomes a post on the
// same SID. Data: GET /scheduling (server/src/routes/scheduling.js).

type Data = { tasks: Task[]; me: string | null; admin: boolean; scheduler: boolean };
const TABS: { key: SchedStage; color: string; empty: string }[] = [
  { key: "to_schedule", color: "oklch(0.72 0.15 65)", empty: "Nothing waiting. Approved reels, carousels and posts arrive here." },
  { key: "scheduled", color: "oklch(0.62 0.13 230)", empty: "Nothing scheduled yet. Set a post date on one waiting to be scheduled." },
  { key: "links_due", color: "oklch(0.62 0.19 25)", empty: "No links due. Two days after a post date, it waits here for its links." },
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
  const load = useCallback(async () => {
    try {
      setData(await api<Data>("/scheduling"));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load the scheduling list.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const staged = useMemo(() => (data?.tasks ?? []).map((t) => ({ t, stage: scheduleStage(t) ?? "to_schedule" })), [data]);
  const count = (k: SchedStage) => staged.filter((x) => x.stage === k).length;
  const rows = staged.filter((x) => x.stage === tab).map((x) => x.t);
  const edOf = (id: string | null) => (editors ?? []).find((e) => e.id === id) ?? null;
  const openTask = openId ? (data?.tasks ?? []).find((t) => t.id === openId) ?? null : null;
  const color = TABS.find((x) => x.key === tab)!.color;

  if (error) return <section className="screen pp"><div className="pp-card sch-empty">{error}</div></section>;
  if (!data) return <section className="screen"><Loader label="Loading…" /></section>;
  return (
    <section className="screen pp sch-page">
      <div className="pp-top">
        <div className="pp-title">
          <h1>Scheduling</h1>
          <span>{data.admin && !data.scheduler ? "Everyone's scheduling, for admins." : "Set a post date to take one. Once it's up, paste its links in the task."}</span>
        </div>
        <span className="pp-grow" />
        <div className="pp-seg" role="tablist" aria-label="Stage">
          {TABS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>
              <i className="sch-dot" style={{ background: x.color }} />{STAGE_WORDS[x.key]}<span className="pp-n">{count(x.key)}</span>
            </button>
          ))}
        </div>
      </div>

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
                <span>{t.post_on ? <>{dayWords(t.post_on)}{t.post_time ? <small className="pp-faint"> · {clockWords(t.post_time)}</small> : null}</> : <span className="pp-faint">—</span>}</span>
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
