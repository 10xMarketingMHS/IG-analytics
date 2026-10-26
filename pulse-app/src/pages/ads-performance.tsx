import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Loader } from "@/components/loader";
import { gradFor, initialsOf } from "@/lib/editor-visuals";
import { ymd } from "@/lib/task-points";
import { countWords, dayShort, pctWords, roasWords, rupees, scoreWords, windowTone, type AdResults, type ResultsPatch } from "@/lib/ad-results";
import "./pipeline.css";
import "./scheduling.css";
import "./ads-performance.css";

// Ads performance (server/src/routes/ads-performance.js) — everyone's view of
// the ads, like the team's "Ads Tracker" sheet: the Ad tasks set in a date
// range (the sheet's Date), each with its results so far — from Animus for
// VSL, typed in for the other teams — added up per editor and per team the way
// the sheet's Editor Performance tab did. The Managers and Team Leads type the
// other teams' results in Fill in. Shown only: no goal or score counts them.

type Summary = {
  key: string; name: string; ads: number; avgHook: number | null; avgHold: number | null; leads: number | null; conversions: number | null;
  leadToConv: number | null; avgRoas: number | null; spend: number | null; avgScore: number | null; done: number; pending: number; published: number;
};
type AdRow = {
  id: string; aid: string; title: string; status: string; videoLink: string | null; setOn: string; approvedAt: string | null;
  editorId: string | null; editorName: string | null; teamId: string | null; teamName: string | null; typeName: string | null;
  stage: "pending" | "done" | "published"; adRefs: string[]; ads: ({ id: string; ref: string } & AdResults)[];
  results: (AdResults & { spend: number | null }) | null; window: string | null;
};
type Data = { from: string | null; to: string | null; today: string; teams: { id: string; name: string }[]; ads: AdRow[]; editors: Summary[]; byTeam: Summary[] };

type Preset = "month" | "last" | "30" | "all" | "custom";
const PRESETS: [Preset, string][] = [["month", "This month"], ["last", "Last month"], ["30", "Last 30 days"], ["all", "All time"], ["custom", "Custom"]];
function rangeOf(p: Preset, custom: { from: string; to: string }): { from: string | null; to: string | null } {
  const now = new Date();
  if (p === "month") return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  if (p === "last") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (p === "30") return { from: ymd(new Date(now.getTime() - 29 * 86_400_000)), to: ymd(now) };
  if (p === "all") return { from: null, to: null };
  return { from: custom.from || null, to: custom.to || null };
}
const STAGE_WORDS = { pending: "Pending", done: "Done", published: "Published" } as const;
const pctOf = (v: number | null) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);

export function AdsPerformancePage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [team, setTeam] = useState<string>("all");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fill, setFill] = useState(false);
  // the Managers and Team Leads type in results (the same people who record ads)
  const { data: lead } = useResource<{ allowed: boolean }>("/ad-uploads/access");
  const range = rangeOf(preset, custom);
  const qs = new URLSearchParams({ ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}), ...(team !== "all" ? { team } : {}) }).toString();
  const load = useCallback(async () => {
    try {
      setData(await api<Data>(`/ads-performance${qs ? `?${qs}` : ""}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load Ads performance.");
    }
  }, [qs]);
  useEffect(() => { load(); }, [load]);
  const openTask = (id: string) => navigate("/tasks", { state: { openTask: id } });

  const totals = useMemo(() => {
    const rows = data?.ads ?? [];
    const sum = (k: "leads" | "conversions" | "spend") => rows.reduce((s, r) => s + (r.results?.[k] ?? 0), 0);
    return { ads: rows.length, published: rows.filter((r) => r.stage === "published").length, leads: sum("leads"), conversions: sum("conversions"), spend: sum("spend") };
  }, [data]);

  if (error) return <section className="screen pp"><div className="pp-card ap-empty">{error}</div></section>;
  return (
    <section className="screen pp ap">
      <div className="pp-top">
        <div className="pp-title">
          <h1>Ads performance</h1>
          <span>Every ad set in the dates you pick, with its results so far: from Animus for VSL, typed in for the other teams.</span>
        </div>
        <span className="pp-grow" />
        <div className="pp-seg" role="group" aria-label="Dates">
          {PRESETS.map(([k, l]) => <button key={k} type="button" className={preset === k ? "on" : ""} onClick={() => setPreset(k)}>{l}</button>)}
        </div>
      </div>
      {preset === "custom" && (
        <div className="ap-custom">
          <label>From<input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
          <label>To<input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
        </div>
      )}
      <div className="ap-chips" role="group" aria-label="Team">
        {[{ id: "all", name: "All teams" }, ...(data?.teams ?? [])].map((t) => (
          <button key={t.id} type="button" className={team === t.id ? "on" : ""} aria-pressed={team === t.id} onClick={() => setTeam(t.id)}>{t.name}</button>
        ))}
      </div>

      {!data ? <Loader label="Loading…" /> : (
        <>
          <div className="ap-kpis">
            <div><span>Ads</span><b>{totals.ads}</b><em>{totals.published} published</em></div>
            <div><span>Leads</span><b>{countWords(totals.leads)}</b><em>{countWords(totals.conversions)} conversions</em></div>
            <div><span>Lead → Conv</span><b>{totals.leads ? pctOf(totals.conversions / totals.leads) : "—"}</b><em>conversions per lead</em></div>
            <div><span>Spend</span><b>{totals.spend ? rupees(totals.spend) : "—"}</b><em>VSL, from Animus</em></div>
          </div>

          <SummaryTable title="Editors" who="Editor" rows={data.editors} />
          <SummaryTable title="Teams" who="Team" rows={data.byTeam} />

          <section className="pp-card ap-card">
            <div className="ap-head">
              <b>Every ad</b><span className="ap-count">{data.ads.length}</span>
              <span className="pp-grow" />
              {lead?.allowed && (
                <div className="pp-seg" role="group" aria-label="View">
                  <button type="button" className={!fill ? "on" : ""} onClick={() => setFill(false)}>Figures</button>
                  <button type="button" className={fill ? "on" : ""} onClick={() => setFill(true)}>Fill in</button>
                </div>
              )}
            </div>
            {fill ? <FillIn rows={data.ads} onSaved={load} /> : (
              <div className="pp-scroll"><div className="ap-grid ap-ads">
                <div className="pp-th"><span>Ad</span><span>Editor</span><span>Team</span><span>Set on</span><span>Ads</span>
                  <span className="r">Hook</span><span className="r">Hold</span><span className="r">Leads</span><span className="r">Conv.</span><span className="r">ROAS</span>
                  <span>Status</span><span>Published</span><span>Window</span></div>
                {data.ads.length === 0 && <div className="ap-empty">No Ad tasks were set in these dates.</div>}
                {data.ads.map((r) => (
                  <div key={r.id} className="pp-tr" role="button" tabIndex={0} style={{ ["--tc" as string]: r.stage === "published" ? "oklch(0.58 0.12 185)" : r.stage === "done" ? "oklch(0.72 0.15 65)" : "#a1a1aa" }}
                    onClick={() => openTask(r.id)} onKeyDown={(e) => { if (e.key === "Enter") openTask(r.id); }}>
                    <span className="pp-cell-title">
                      <b>{r.title}</b>
                      <span><span className="pp-ref">{r.aid}</span>{r.typeName && <em className="pp-type">{r.typeName.toUpperCase()}</em>}
                        {r.videoLink && <a className="ap-link" href={r.videoLink} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open the work ↗</a>}</span>
                    </span>
                    <span className="pp-ed"><span className="pp-ava" style={{ width: 22, height: 22, background: gradFor(r.editorName ?? "?") }}>{initialsOf(r.editorName ?? "?")}</span><b>{r.editorName ?? "—"}</b></span>
                    <span className="ap-faint">{r.teamName ?? "—"}</span>
                    <span className="ap-faint">{dayShort(r.setOn)}</span>
                    <span className="ap-refs">{r.adRefs.length ? r.adRefs.join(", ") : "—"}</span>
                    <span className="r">{pctWords(r.results?.hookRate)}</span>
                    <span className="r">{pctWords(r.results?.holdRate)}</span>
                    <span className="r">{countWords(r.results?.leads)}</span>
                    <span className="r">{countWords(r.results?.conversions)}</span>
                    <span className="r">{roasWords(r.results?.roas)}</span>
                    <span className="ap-status"><b className={r.stage}>{STAGE_WORDS[r.stage]}</b>{r.results?.adStatus && <em className={r.results.adStatus === "Active" ? "on" : ""}>{r.results.adStatus}</em>}</span>
                    <span className="ap-faint">{dayShort(r.results?.publishedOn)}</span>
                    <span>{r.window ? <span className={"ap-window " + windowTone(r.window)}>{r.window}</span> : <span className="ap-faint">—</span>}</span>
                  </div>
                ))}
              </div></div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

// Editors or teams, as the sheet's Editor Performance tab added them up.
function SummaryTable({ title, who, rows }: { title: string; who: string; rows: Summary[] }) {
  return (
    <section className="pp-card ap-card">
      <div className="ap-head"><b>{title}</b><span className="ap-count">{rows.length}</span></div>
      <div className="pp-scroll"><div className="ap-grid ap-sum">
        <div className="pp-th"><span>{who}</span><span className="r">Ads</span><span className="r">Avg hook</span><span className="r">Avg hold</span><span className="r">Leads</span>
          <span className="r">Conv.</span><span className="r">Lead → Conv</span><span className="r">Avg ROAS</span><span className="r">Spend</span><span className="r">Score</span>
          <span className="r">Done</span><span className="r">Pending</span><span className="r">Published</span></div>
        {rows.length === 0 && <div className="ap-empty">Nothing in these dates.</div>}
        {rows.map((r) => (
          <div key={r.key} className="pp-tr ap-plain" style={{ ["--tc" as string]: "transparent" }}>
            <span className="pp-ed">{who === "Editor" && <span className="pp-ava" style={{ width: 22, height: 22, background: gradFor(r.name) }}>{initialsOf(r.name)}</span>}<b>{r.name}</b></span>
            <span className="r">{r.ads}</span>
            <span className="r">{pctWords(r.avgHook)}</span>
            <span className="r">{pctWords(r.avgHold)}</span>
            <span className="r">{countWords(r.leads)}</span>
            <span className="r">{countWords(r.conversions)}</span>
            <span className="r">{pctOf(r.leadToConv)}</span>
            <span className="r">{roasWords(r.avgRoas)}</span>
            <span className="r">{rupees(r.spend)}</span>
            <span className="r">{scoreWords(r.avgScore)}</span>
            <span className="r">{r.done}</span>
            <span className="r">{r.pending}</span>
            <span className="r">{r.published}</span>
          </div>
        ))}
      </div></div>
    </section>
  );
}

// Fill in, like the sheet: one row per recorded ad of a team without Animus;
// each row saves on its own. Animus's ads aren't here — it sends theirs.
function FillIn({ rows, onSaved }: { rows: AdRow[]; onSaved: () => void }) {
  const ads = rows.flatMap((t) => t.ads.filter((a) => a.source !== "animus").map((a) => ({ task: t, ad: a })));
  return (
    <div className="pp-scroll"><div className="ap-grid ap-fill">
      <div className="pp-th"><span>Ad</span><span>Task</span><span>Published on</span><span>Hook %</span><span>Hold %</span><span>Leads</span><span>Conv.</span><span>ROAS</span><span>Status</span><span>Notes</span><span /></div>
      {ads.length === 0 && <div className="ap-empty">No typed-in ads in these dates. Record an ad's number in its task's Ad uploads first; Animus's ads fill themselves in.</div>}
      {ads.map(({ task, ad }) => <FillRow key={ad.id} taskId={task.id} title={`${task.aid} · ${task.title}`} ad={ad} onSaved={onSaved} />)}
    </div></div>
  );
}

function FillRow({ taskId, title, ad, onSaved }: { taskId: string; title: string; ad: { id: string; ref: string } & AdResults; onSaved: () => void }) {
  const start = {
    publishedOn: ad.publishedOn ?? "", hook: ad.hookRate == null ? "" : String(Math.round(ad.hookRate * 1000) / 10),
    hold: ad.holdRate == null ? "" : String(Math.round(ad.holdRate * 1000) / 10), leads: ad.leads == null ? "" : String(ad.leads),
    conversions: ad.conversions == null ? "" : String(ad.conversions), roas: ad.roas == null ? "" : String(ad.roas),
    adStatus: (ad.adStatus as string) ?? "", notes: ad.notes ?? "",
  };
  const [f, setF] = useState(start);
  const [busy, setBusy] = useState(false);
  const changed = JSON.stringify(f) !== JSON.stringify(start);
  const n = (s: string) => (s.trim() === "" ? null : Number(s));
  const bad = [f.hook, f.hold].some((s) => s.trim() !== "" && (isNaN(Number(s)) || Number(s) < 0 || Number(s) > 100))
    || [f.leads, f.conversions].some((s) => s.trim() !== "" && !/^\d+$/.test(s.trim()))
    || (f.roas.trim() !== "" && (isNaN(Number(f.roas)) || Number(f.roas) < 0));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    const patch: ResultsPatch = {
      publishedOn: f.publishedOn || null, adStatus: (f.adStatus || null) as ResultsPatch["adStatus"],
      hookRate: n(f.hook) == null ? null : n(f.hook)! / 100, holdRate: n(f.hold) == null ? null : n(f.hold)! / 100,
      leads: n(f.leads), conversions: n(f.conversions), roas: n(f.roas), notes: f.notes.trim() || null,
    };
    setBusy(true);
    try {
      await api(`/tasks/${taskId}/ads/${ad.id}/results`, { method: "PATCH", body: JSON.stringify(patch) });
      toast.success(`${ad.ref} saved.`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pp-tr ap-plain ap-fillrow" style={{ ["--tc" as string]: changed ? "oklch(0.72 0.15 65)" : "transparent" }}>
      <span className="ap-refs">{ad.ref}</span>
      <span className="ap-faint ap-ellipsis" title={title}>{title}</span>
      <input type="date" value={f.publishedOn} onChange={set("publishedOn")} aria-label={`${ad.ref} published on`} />
      <input inputMode="decimal" value={f.hook} placeholder="17" onChange={set("hook")} aria-label={`${ad.ref} hook %`} />
      <input inputMode="decimal" value={f.hold} placeholder="29" onChange={set("hold")} aria-label={`${ad.ref} hold %`} />
      <input inputMode="numeric" value={f.leads} placeholder="0" onChange={set("leads")} aria-label={`${ad.ref} leads`} />
      <input inputMode="numeric" value={f.conversions} placeholder="0" onChange={set("conversions")} aria-label={`${ad.ref} conversions`} />
      <input inputMode="decimal" value={f.roas} placeholder="3.6" onChange={set("roas")} aria-label={`${ad.ref} ROAS`} />
      <select value={f.adStatus} onChange={set("adStatus")} aria-label={`${ad.ref} status`}>
        <option value="">—</option><option value="Active">Active</option><option value="Inactive">Inactive</option>
      </select>
      <input value={f.notes} maxLength={500} onChange={set("notes")} aria-label={`${ad.ref} notes`} />
      <button type="button" className="sch-btn" disabled={busy || !changed || bad} onClick={save}>{busy ? "…" : "Save"}</button>
    </div>
  );
}
