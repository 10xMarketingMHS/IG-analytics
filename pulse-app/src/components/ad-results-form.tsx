import { useState } from "react";
import type { AdResults, ResultsPatch } from "@/lib/ad-results";

// An ad's results typed in (Ads performance) — the boxes of the team's sheet:
// published on, hook %, hold %, leads, conversions, ROAS, ad status, notes.
// Rates are typed as percents (17) and sent as fractions (0.17). An ad whose
// results Animus sends only takes notes here. Used in the task window's Ad
// uploads part and the Ads performance page's Fill in.

const pctIn = (v: number | null | undefined) => (v == null ? "" : String(Math.round(v * 1000) / 10));
const numIn = (v: number | null | undefined) => (v == null ? "" : String(v));

export function AdResultsForm({ results, onSave, onCancel, busy, compact = false }: {
  results: AdResults | null | undefined;
  onSave: (patch: ResultsPatch) => void;
  onCancel?: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const fromAnimus = results?.source === "animus";
  const [f, setF] = useState({
    publishedOn: results?.publishedOn ?? "", adStatus: (results?.adStatus as string) ?? "",
    hook: pctIn(results?.hookRate), hold: pctIn(results?.holdRate), leads: numIn(results?.leads),
    conversions: numIn(results?.conversions), roas: numIn(results?.roas), notes: results?.notes ?? "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const n = (s: string) => (s.trim() === "" ? null : Number(s));
  const bad = [f.hook, f.hold].some((s) => s.trim() !== "" && (isNaN(Number(s)) || Number(s) < 0 || Number(s) > 100))
    || [f.leads, f.conversions].some((s) => s.trim() !== "" && (!/^\d+$/.test(s.trim())))
    || (f.roas.trim() !== "" && (isNaN(Number(f.roas)) || Number(f.roas) < 0));

  function save() {
    if (fromAnimus) { onSave({ notes: f.notes.trim() || null }); return; }
    onSave({
      publishedOn: f.publishedOn || null, adStatus: (f.adStatus || null) as ResultsPatch["adStatus"],
      hookRate: n(f.hook) == null ? null : n(f.hook)! / 100, holdRate: n(f.hold) == null ? null : n(f.hold)! / 100,
      leads: n(f.leads), conversions: n(f.conversions), roas: n(f.roas), notes: f.notes.trim() || null,
    });
  }

  return (
    <div className={"adr-form" + (compact ? " compact" : "")}>
      {!fromAnimus && (
        <div className="adr-grid">
          <label>Published on<input type="date" value={f.publishedOn} onChange={set("publishedOn")} /></label>
          <label>Hook %<input inputMode="decimal" value={f.hook} placeholder="17" onChange={set("hook")} /></label>
          <label>Hold %<input inputMode="decimal" value={f.hold} placeholder="29" onChange={set("hold")} /></label>
          <label>Leads<input inputMode="numeric" value={f.leads} placeholder="0" onChange={set("leads")} /></label>
          <label>Conversions<input inputMode="numeric" value={f.conversions} placeholder="0" onChange={set("conversions")} /></label>
          <label>ROAS<input inputMode="decimal" value={f.roas} placeholder="3.6" onChange={set("roas")} /></label>
          <label>Ad status
            <select value={f.adStatus} onChange={set("adStatus")}>
              <option value="">—</option><option value="Active">Active</option><option value="Inactive">Inactive</option>
            </select>
          </label>
        </div>
      )}
      <label className="adr-notes">Notes<input value={f.notes} maxLength={500} placeholder={fromAnimus ? "Animus sends the numbers; notes are yours" : "Anything worth knowing"} onChange={set("notes")} /></label>
      <div className="adr-acts">
        {onCancel && <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || bad}>{busy ? "Saving…" : "Save results"}</button>
      </div>
    </div>
  );
}
