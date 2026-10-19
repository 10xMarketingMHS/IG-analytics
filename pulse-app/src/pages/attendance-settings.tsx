import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useOrg } from "@/lib/use-org";
import { clockTime } from "@/lib/time-format";
import type { AttSettings } from "@/lib/use-attendance";
import { SI, Stepper, Toggle } from "@/pages/settings-ui";

// Settings › Attendance (Pulse Redesign v7) — admins. Start of day (require it,
// the grace period, the no-SOD alert, auto-absent, the end-of-day wrap-up,
// correction requests) and the penalties taken from the discipline score.
// Office hours come from General › Work calendar. Kept as a draft until Save.

const DEFAULTS: AttSettings = {
  requireSod: true, graceMinutes: 10, noSodAlertAt: "09:30", autoAbsentAt: "11:00", autoAbsentEnabled: true,
  requireEodNote: true, allowCorrections: true, latePenaltyPts: 1, absentPenaltyPts: 3, deductCapacity: true,
};
const at = (hhmm: string) => { const d = new Date(); const [h, m] = hhmm.split(":").map(Number); d.setHours(h || 0, m || 0, 0, 0); return d; };
const plus = (hhmm: string, min: number) => { const d = at(hhmm); d.setMinutes(d.getMinutes() + min); return d; };

export function AttendanceSection({ onDirty }: { onDirty: (d: boolean) => void }) {
  const { org, refetch } = useOrg();
  const saved: AttSettings = { ...DEFAULTS, ...(org?.attendance ?? {}) };
  const [draft, setDraft] = useState<AttSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const a = draft ?? saved;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const set = <K extends keyof AttSettings>(k: K, v: AttSettings[K]) => setDraft({ ...a, [k]: v });
  const cal = org?.calendar;
  const hours = cal ? `${clockTime(at(cal.wdFrom))} – ${clockTime(at(cal.wdTo))}` : "";

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await api("/org", { method: "PATCH", body: JSON.stringify({ attendance: draft }) });
      await refetch();
      setDraft(null);
      window.dispatchEvent(new Event("pulse:attendance-changed"));
      toast.success("Attendance rules saved.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the attendance rules.");
    } finally {
      setSaving(false);
    }
  }

  const summary = `On time until ${clockTime(plus(cal?.wdFrom ?? "09:00", a.graceMinutes))}  ·  late after that  ·  alert at ${clockTime(at(a.noSodAlertAt))}`
    + (a.autoAbsentEnabled ? `  ·  absent at ${clockTime(at(a.autoAbsentAt))}` : "  ·  no auto-absent");

  return (
    <>
      <section className="st-card">
        <div className="st-cardhead"><b>Start of day</b><span>Office hours come from General › Work calendar{hours ? ` (${hours})` : ""}.</span></div>
        <div className="st-row">
          <span className="st-label"><b>Require Start of day</b><small>Editors tap Start day before their task timers unlock</small></span>
          <Toggle on={a.requireSod} onChange={(v) => set("requireSod", v)} label="Require Start of day" />
        </div>
        <div className="st-row">
          <span className="st-label"><b>Grace period</b><small>Minutes after opening that still count as on time</small></span>
          <Stepper label="grace" value={`${a.graceMinutes}m`} onDec={() => set("graceMinutes", Math.max(0, a.graceMinutes - 5))} onInc={() => set("graceMinutes", Math.min(30, a.graceMinutes + 5))}
            decDisabled={a.graceMinutes <= 0} incDisabled={a.graceMinutes >= 30} />
        </div>
        <div className="st-row">
          <span className="st-label"><b>No-SOD alert</b><small>Ping the editor and their lead if there's no check-in by</small></span>
          <input type="time" className="st-in st-time" value={a.noSodAlertAt} onChange={(e) => e.target.value && set("noSodAlertAt", e.target.value)} aria-label="No-SOD alert time" />
        </div>
        <div className="st-row">
          <span className="st-label"><b>Auto-mark absent</b><small>No check-in by this time marks the day absent — a lead can undo it</small></span>
          <span className="st-inline">
            <input type="time" className="st-in st-time" value={a.autoAbsentAt} onChange={(e) => e.target.value && set("autoAbsentAt", e.target.value)} aria-label="Auto-absent time" disabled={!a.autoAbsentEnabled} />
            <Toggle on={a.autoAbsentEnabled} onChange={(v) => set("autoAbsentEnabled", v)} label="Auto-mark absent" />
          </span>
        </div>
        <div className="st-row">
          <span className="st-label"><b>End of day wrap-up</b><small>Ask for a short note before checking out</small></span>
          <Toggle on={a.requireEodNote} onChange={(v) => set("requireEodNote", v)} label="End of day wrap-up" />
        </div>
        <div className="st-row">
          <span className="st-label"><b>Correction requests</b><small>Editors who forgot to tap Start day can ask a lead to fix the time</small></span>
          <Toggle on={a.allowCorrections} onChange={(v) => set("allowCorrections", v)} label="Correction requests" />
        </div>
        <div className="st-row">
          <span className="st-summary">{summary}</span>
        </div>
      </section>

      <section className="st-card">
        <div className="st-cardhead"><b>Penalties</b><span>Taken from the discipline score on Goals and Management Performance.</span></div>
        <div className="st-row">
          <span className="st-label"><b>Late check-in</b><small>Per late day, unless a lead excuses it</small></span>
          <Stepper label="late penalty" value={`−${a.latePenaltyPts} pt${a.latePenaltyPts === 1 ? "" : "s"}`} onDec={() => set("latePenaltyPts", Math.max(0, a.latePenaltyPts - 1))} onInc={() => set("latePenaltyPts", Math.min(10, a.latePenaltyPts + 1))}
            decDisabled={a.latePenaltyPts <= 0} incDisabled={a.latePenaltyPts >= 10} />
        </div>
        <div className="st-row">
          <span className="st-label"><b>Unplanned absence</b><small>Absent without approved leave</small></span>
          <Stepper label="absence penalty" value={`−${a.absentPenaltyPts} pt${a.absentPenaltyPts === 1 ? "" : "s"}`} onDec={() => set("absentPenaltyPts", Math.max(0, a.absentPenaltyPts - 1))} onInc={() => set("absentPenaltyPts", Math.min(10, a.absentPenaltyPts + 1))}
            decDisabled={a.absentPenaltyPts <= 0} incDisabled={a.absentPenaltyPts >= 10} />
        </div>
        <div className="st-row">
          <span className="st-label"><b>Count lost hours against capacity</b><small>Unplanned absence shows as lost hours on the Team › Attendance report</small></span>
          <Toggle on={a.deductCapacity} onChange={(v) => set("deductCapacity", v)} label="Count lost hours against capacity" />
        </div>
      </section>

      {dirty && (
        <div className="st-savebar" role="region" aria-label="Unsaved changes">
          <span><i />Unsaved changes</span>
          <span className="st-grow" />
          <button type="button" className="st-btn" onClick={() => setDraft(null)} disabled={saving}>Discard</button>
          <button type="button" className="st-btn grad" onClick={save} disabled={saving}>{SI.check}{saving ? "Saving…" : "Save changes"}</button>
        </div>
      )}
    </>
  );
}
