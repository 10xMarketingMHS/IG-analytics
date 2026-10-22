import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { applyLeave, cancelMyLeave, leaveWords, type LeaveKind, type MyLeave } from "@/lib/use-attendance";

// Leave on the Start day card and bar: what you have this year, what's booked,
// and the form to apply — CL (casual) or SL (sick), the days, a half day, a
// note for your lead, who approves it. CL told fewer than the notice days
// ahead is short notice; past the year's CL the days are unpaid. No points are
// shown here (only leads see those).

const half = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// "CL: 2 of 4 left this year · SL taken: 1"
export function leaveLine(l: MyLeave) {
  const cl = l.perYear == null || l.perYear === 0
    ? "No CL set for you yet"
    : `CL: ${half(Math.max(0, l.perYear - l.cl))} of ${half(l.perYear)} left this year`;
  const waiting = l.waitingCl + l.waitingSl;
  return `${cl}${l.unpaid ? ` · ${half(l.unpaid)} unpaid` : ""}${l.sl ? ` · SL taken: ${half(l.sl)}` : ""}${waiting ? ` · ${half(waiting)} waiting on your lead` : ""}`;
}

export function LeaveAsk({ today, leave, onDone }: { today: string; leave: MyLeave; onDone: () => void }) {
  const [kind, setKind] = useState<LeaveKind>("cl");
  const [from, setFrom] = useState(addDays(today, leave.noticeDays));
  const [to, setTo] = useState("");
  const [isHalf, setIsHalf] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const oneDay = !to || to === from;
  const clLeft = Math.max(0, (leave.perYear ?? 0) - leave.cl - leave.waitingCl);
  const short = kind === "cl" && !!from && from < addDays(today, leave.noticeDays);
  const pickKind = (k: LeaveKind) => {
    setKind(k);
    // SL is often for today; CL starts at the earliest day with enough notice
    if (k === "sl" && from > today) setFrom(today);
    if (k === "cl" && from < today) setFrom(today);
  };
  async function send() {
    setBusy(true);
    try {
      const l = await applyLeave({ kind, from, to: oneDay ? undefined : to, half: oneDay && isHalf, note: note.trim() || undefined });
      toast.success(`Applied: ${leaveWords(l)}. Your lead approves it.`);
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send that request.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setCancelling(id);
    try {
      await cancelMyLeave(id);
      toast.success("Leave cancelled.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't cancel it.");
    } finally {
      setCancelling(null);
    }
  }
  const booked = leave.mine.filter((l) => l.dates[l.dates.length - 1] >= today);
  return (
    <div className="sd-corr lv-ask" role="group" aria-label="Apply for leave">
      <div className="lv-kinds" role="radiogroup" aria-label="Kind of leave">
        <button type="button" role="radio" aria-checked={kind === "cl"} className={kind === "cl" ? "on" : ""} onClick={() => pickKind("cl")}>CL · casual</button>
        <button type="button" role="radio" aria-checked={kind === "sl"} className={kind === "sl" ? "on" : ""} onClick={() => pickKind("sl")}>SL · sick</button>
      </div>
      <label>From <input type="date" value={from} min={kind === "sl" ? addDays(today, -7) : today} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Last day (leave empty for one day)" /></label>
      {oneDay && (
        <label className="lv-half"><input type="checkbox" checked={isHalf} onChange={(e) => setIsHalf(e.target.checked)} /> Half day</label>
      )}
      <input type="text" className="sd-corr-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for your lead (optional)" maxLength={300} />
      <button type="button" className="sd-btn" onClick={send} disabled={busy || !from}>{busy ? "Sending…" : "Apply"}</button>
      <span className={"sd-faint lv-hint" + (short ? " warn" : "")}>
        {kind === "sl"
          ? "SL: any time, no limit. It can go back a week."
          : short
            ? `Short notice: CL needs ${leave.noticeDays} days' notice, so this counts as unplanned leave.`
            : leave.perYear
              ? clLeft > 0 ? `${half(clLeft)} CL left to apply for this year. Days past that are unpaid.` : "No CL left this year: this will be unpaid leave."
              : "No CL is set for you yet, so CL is unpaid leave for now."}
      </span>
      {booked.length > 0 && (
        <ul className="lv-mine">
          {booked.map((l) => (
            <li key={l.id}>
              <b>{leaveWords(l)}</b>
              <span className={"lv-state " + l.status}>{l.status === "requested" ? "Waiting on your lead" : "Approved"}</span>
              {(l.status === "requested" || l.dates[0] > today) && (
                <button type="button" className="sd-link" disabled={cancelling === l.id} onClick={() => cancel(l.id)}>Cancel</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
