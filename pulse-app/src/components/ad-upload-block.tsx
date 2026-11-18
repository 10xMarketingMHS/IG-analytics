import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { AD_STAGE_WORDS, splitAdRefs, type TaskAds } from "@/lib/ad-upload";
import { countWords, dayShort, pctWords, roasWords, rupees, scoreWords, windowTone, type AdResults, type ResultsPatch } from "@/lib/ad-results";
import { AdResultsForm } from "@/components/ad-results-form";
import type { Task } from "@/lib/types";
import "./schedule-block.css";
import "./ad-upload-block.css";

// The Ad uploads part of an approved Ad task's window (server/src/routes/ad-uploads.js):
// which ads it became, recorded by the Managers and Team Leads — the AD numbers
// Animus gave it, or the names another team sends back. Hidden for tasks that
// aren't in the list. Everyone who can open the task sees the ads; the ones
// Animus sent back (server/src/routes/animus.js) say so. Under each ad, its
// results (Ads performance): from Animus after every sync, or typed in by the
// Managers and Team Leads, with the 14-day window after it went live.

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function AdUploadBlock({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { data, refetch } = useResource<TaskAds>(`/tasks/${task.id}/ads`);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const s = data?.ready && data.inFlow ? data : null;
  if (!s) return null;

  const stage = s.stage ?? "to_upload";
  const ads = s.ads ?? [];
  const refs = splitAdRefs(text);
  const say = ads.length
    ? `Runs as ${ads.length === 1 ? "1 ad" : `${ads.length} ads`}. ${s.canRecord ? "Add another if it runs again, as a copy or for another ad set." : ""}`
    : s.canRecord
      ? "Approved. Once it's uploaded, record its ad numbers here: the AD number from Animus, or the ad's name the team sends back."
      : "Approved. Waiting for its ad numbers to be recorded.";

  async function call(path: string, init: RequestInit, ok: string) {
    setBusy(true);
    try {
      await api(path, init);
      await refetch();
      onChanged();
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error(errText(e, "Couldn't save that."));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveResults(adId: string, ref: string, patch: ResultsPatch) {
    const done = await call(`/tasks/${task.id}/ads/${adId}/results`, { method: "PATCH", body: JSON.stringify(patch) }, `${ref}'s results saved.`);
    if (done) setEditing(null);
  }
  async function add() {
    if (!refs.length) return;
    const done = await call(`/tasks/${task.id}/ads`, { method: "POST", body: JSON.stringify({ refs }) },
      `Recorded ${refs.join(", ")}.`);
    if (done) setText("");
  }

  return (
    <section className="sch adu" aria-label="Ad uploads">
      <div className="sch-head">
        <b>Ad uploads</b>
        <span className={"sch-pill " + stage}>{AD_STAGE_WORDS[stage]}</span>
      </div>
      <p className="sch-say">{say}</p>
      {ads.length > 0 && (
        <div className="adu-list">
          {ads.map((a) => (
            <div key={a.id} className="adu-row">
              <div className="adu-rowhead">
                <span className="adu-ad" title={`${a.source === "animus" ? "Sent by Animus" : `Recorded by ${a.byName ?? "someone"}`}, ${new Date(a.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}>
                  <b>{a.ref}</b>
                  {a.source === "animus" && <em className="adu-src">Animus</em>}
                  {s.canRecord && (
                    <button type="button" aria-label={`Take ${a.ref} off`} disabled={busy}
                      onClick={() => { if (window.confirm(`Take ${a.ref} off this task?`)) call(`/tasks/${task.id}/ads/${a.id}`, { method: "DELETE" }, `${a.ref} taken off.`); }}>×</button>
                  )}
                </span>
                {a.window && <span className={"adu-window " + windowTone(a.window)} title="The 14 days after it went live">{a.window}</span>}
                <span className="sch-grow" />
                {(s.canResults ?? s.canRecord) && a.results !== undefined && editing !== a.id && (
                  <button type="button" className="adu-edit" onClick={() => setEditing(a.id)}>
                    {a.results?.source === "animus" ? "Notes" : a.results?.source ? "Edit results" : "Add results"}
                  </button>
                )}
              </div>
              {a.results?.source && <ResultsLine r={a.results} />}
              {editing === a.id && (
                <AdResultsForm results={a.results} busy={busy} onCancel={() => setEditing(null)} onSave={(p) => saveResults(a.id, a.ref, p)} />
              )}
            </div>
          ))}
        </div>
      )}
      {s.canRecord && (
        <div className="adu-add">
          <input value={text} placeholder="AD205, AD206, or the ad's name" aria-label="Ad numbers or names"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) add(); }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !refs.length} onClick={add}>
            {busy ? "Saving…" : refs.length > 1 ? `Add ${refs.length} ads` : "Add"}
          </button>
        </div>
      )}
    </section>
  );
}

// One ad's results in a line: what's known of them, Animus's spend and score too.
function ResultsLine({ r }: { r: AdResults }) {
  const parts = [
    r.adStatus ? <b key="s" className={"adu-status " + (r.adStatus === "Active" ? "on" : "")}>{r.adStatus}</b> : null,
    r.publishedOn ? <span key="p">Live {dayShort(r.publishedOn)}</span> : null,
    r.spend != null ? <span key="sp">{rupees(r.spend)}</span> : null,
    <span key="h">Hook {pctWords(r.hookRate)}</span>,
    <span key="hd">Hold {pctWords(r.holdRate)}</span>,
    <span key="l">{countWords(r.leads)} leads</span>,
    <span key="c">{countWords(r.conversions)} conv.</span>,
    <span key="r">ROAS {roasWords(r.roas)}</span>,
    r.score != null ? <span key="sc">Score {scoreWords(r.score)}</span> : null,
  ].filter(Boolean);
  return (
    <div className="adu-results">
      {parts}
      {r.notes && <em className="adu-note">{r.notes}</em>}
      {r.at && <small className="adu-at">{r.source === "animus" ? "From Animus" : "Typed in"}, {new Date(r.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</small>}
    </div>
  );
}
