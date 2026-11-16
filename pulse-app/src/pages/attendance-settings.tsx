import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useOrg } from "@/lib/use-org";
import { clockTime } from "@/lib/time-format";
import { bandMinutes, bandTime, DEFAULT_LATE_BANDS, type AttSettings, type LateBand } from "@/lib/use-attendance";
import { LookOnly, SI, Stepper, Toggle } from "@/pages/settings-ui";
import { useWorkspaces } from "@/lib/workspaces-context";

// Settings › Attendance (Pulse Redesign v7) — admins. Start of day (require it,
// the grace period, the no-SOD alert, auto-absent, the end-of-day wrap-up,
// correction requests) and the late points taken off the overall score.
// Admins change the rules; the penalties and who sees the team's attendance
// only the Super Admin changes (admins see them).
// Office hours come from General › Work calendar. Kept as a draft until Save.

const DEFAULTS: AttSettings = {
  requireSod: true, graceMinutes: 10, noSodAlertAt: "09:30", halfDayAt: "11:30", autoAbsentAt: "13:30", autoAbsentEnabled: true, permissionsPerMonth: 2,
  requireEodNote: true, allowCorrections: true, lateBands: DEFAULT_LATE_BANDS, deductCapacity: true,
  teamView: { manager: true, asstManager: true, teamLead: true },
};
const at = (hhmm: string) => { const d = new Date(); const [h, m] = hhmm.split(":").map(Number); d.setHours(h || 0, m || 0, 0, 0); return d; };
const plus = (hhmm: string, min: number) => { const d = at(hhmm); d.setMinutes(d.getMinutes() + min); return d; };

export function AttendanceSection({ onDirty }: { onDirty: (d: boolean) => void }) {
  const { org, refetch } = useOrg();
  const { isAdmin, pageRule } = useWorkspaces();
  // See without Change (Settings › Page access): every control off
  const canChange = pageRule("setAttendance", "change", isAdmin);
  const isSuper = !!org?.superAdmin;
  const saved: AttSettings = { ...DEFAULTS, ...(org?.attendance ?? {}), teamView: { ...DEFAULTS.teamView!, ...(org?.attendance?.teamView ?? {}) } };
  const [draft, setDraft] = useState<AttSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const a = draft ?? saved;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const set = <K extends keyof AttSettings>(k: K, v: AttSettings[K]) => setDraft({ ...a, [k]: v });
  const cal = org?.calendar;
  const hours = cal ? `${clockTime(at(cal.wdFrom))} – ${clockTime(at(cal.wdTo))}` : "";
  // Late bands: minutes after opening, shown as times of day
  const opening = cal?.wdFrom ?? "09:00";
  const bands: LateBand[] = a.lateBands?.length ? a.lateBands : DEFAULT_LATE_BANDS;
  const setBand = (i: number, b: Partial<LateBand>) => set("lateBands", bands.map((x, j) => (j === i ? { ...x, ...b } : x)));
  // each band ends after the one before (the first after the grace period)
  const bandsOk = bands.every((b, i) => b.upTo == null || b.upTo > (i ? bands[i - 1].upTo ?? 0 : a.graceMinutes));
  const fromOf = (i: number) => clockTime(plus(opening, (i ? bands[i - 1].upTo ?? 0 : a.graceMinutes) + 1));

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

  const summary = `On time until ${clockTime(plus(cal?.wdFrom ?? "09:00", a.graceMinutes))}  ·  late after that (a permission covers it)  ·  alert at ${clockTime(at(a.noSodAlertAt))}`
    + (a.autoAbsentEnabled ? `  ·  half day absent after ${clockTime(at(a.halfDayAt ?? "11:30"))}  ·  absent after ${clockTime(at(a.autoAbsentAt))}` : "  ·  no automatic absence");

  return (
    <LookOnly on={!canChange}>
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
          <span className="st-label"><b>Half day absent</b><small>Not in by this time: a half-day absence (no points). A morning permission covers being late until then</small></span>
          <span className="st-inline">
            <input type="time" className="st-in st-time" value={a.halfDayAt ?? "11:30"} onChange={(e) => e.target.value && set("halfDayAt", e.target.value)} aria-label="Half-day time" disabled={!a.autoAbsentEnabled} />
            <Toggle on={a.autoAbsentEnabled} onChange={(v) => set("autoAbsentEnabled", v)} label="Mark half day and absent automatically" />
          </span>
        </div>
        <div className="st-row">
          <span className="st-label"><b>Absent</b><small>Still not in by this time: absent for the day (no points). A lead can undo either mark</small></span>
          <input type="time" className="st-in st-time" value={a.autoAbsentAt} onChange={(e) => e.target.value && set("autoAbsentAt", e.target.value)} aria-label="Absent time" disabled={!a.autoAbsentEnabled} />
        </div>
        <div className="st-row">
          <span className="st-label"><b>Permissions a month</b><small>Up to 2 hours each, morning (come in late) or evening (leave early). Asked ahead and approved by a lead, or used on the day while any are left</small></span>
          <Stepper label="permissions a month" value={`${a.permissionsPerMonth ?? 2}`} onDec={() => set("permissionsPerMonth", Math.max(0, (a.permissionsPerMonth ?? 2) - 1))} onInc={() => set("permissionsPerMonth", Math.min(10, (a.permissionsPerMonth ?? 2) + 1))}
            decDisabled={(a.permissionsPerMonth ?? 2) <= 0} incDisabled={(a.permissionsPerMonth ?? 2) >= 10} />
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
        <div className="st-cardhead"><b>Penalties</b><span>Late starts come off the overall score (Earned + Discipline) on Goals and Management Performance, by how late. A morning permission or a lead's excuse clears them. Half-day absent and absent cost no points.{isSuper ? "" : " Only a Super Admin can change these."}</span></div>
        {bands.map((b, i) => {
          const last = b.upTo == null;
          return (
            <div className="st-row" key={i}>
              {/* (a time and points side by side: the label gives them room) */}
              <span className="st-label" style={last ? undefined : { flexBasis: 150 }}>
                <b>{last ? "Late, until half day" : "Late, until"}</b>
                <small>{last
                  ? `In from ${fromOf(i)} to ${clockTime(at(a.halfDayAt ?? "11:30"))}, the half-day time`
                  : `In from ${fromOf(i)}${bandsOk ? "" : " · each time must be later than the one before"}`}</small>
              </span>
              <span className="st-inline">
                {!last && (
                  <input type="time" className="st-in st-time" value={bandTime(opening, b.upTo!)} disabled={!isSuper}
                    onChange={(e) => e.target.value && setBand(i, { upTo: bandMinutes(opening, e.target.value) })} aria-label={`Late band ${i + 1} ends at`} />
                )}
                <Stepper label={`late points, band ${i + 1}`} value={`−${b.pts} pt${b.pts === 1 ? "" : "s"}`}
                  onDec={() => setBand(i, { pts: Math.max(0, b.pts - 1) })} onInc={() => setBand(i, { pts: Math.min(50, b.pts + 1) })}
                  decDisabled={!isSuper || b.pts <= 0} incDisabled={!isSuper || b.pts >= 50} />
              </span>
            </div>
          );
        })}
        <div className="st-row">
          <span className="st-label"><b>Leave (CL / SL)</b><small>Notice, the short-notice and unpaid-day cuts, and everyone's allowance are on My Team › Leave › Allowances &amp; rules</small></span>
          <Link className="st-link" to="/my-team?tab=leave&view=settings">Open</Link>
        </div>
        <div className="st-row">
          <span className="st-label"><b>Count lost hours against capacity</b><small>Unplanned absence shows as lost hours on the Team › Attendance report</small></span>
          <Toggle on={a.deductCapacity} disabled={!isSuper} onChange={(v) => set("deductCapacity", v)} label="Count lost hours against capacity" />
        </div>
      </section>

      <section className="st-card">
        <div className="st-cardhead"><b>Team attendance access</b><span>Who besides admins sees the whole team's attendance — Team today on Home and Team › Attendance — and can nudge, excuse and mark people.{isSuper ? "" : " Only a Super Admin can change this."}</span></div>
        {([["manager", "Managers"], ["asstManager", "Asst. Managers"], ["teamLead", "Team Leads"]] as const).map(([k, l]) => (
          <div className="st-row" key={k}>
            <span className="st-label"><b>{l}</b><small>{a.teamView?.[k] ? "See the team's attendance" : "See only their own day"}</small></span>
            <Toggle on={!!a.teamView?.[k]} disabled={!isSuper} onChange={(v) => set("teamView", { ...a.teamView!, [k]: v })} label={`${l} see the team's attendance`} />
          </div>
        ))}
      </section>

      {dirty && (
        <div className="st-savebar" role="region" aria-label="Unsaved changes">
          <span><i />Unsaved changes</span>
          <span className="st-grow" />
          <button type="button" className="st-btn" onClick={() => setDraft(null)} disabled={saving}>Discard</button>
          <button type="button" className="st-btn grad" onClick={save} disabled={saving || !bandsOk} title={bandsOk ? undefined : "Each late band must end later than the one before"}>{SI.check}{saving ? "Saving…" : "Save changes"}</button>
        </div>
      )}
    </LookOnly>
  );
}
