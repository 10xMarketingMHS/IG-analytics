import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import { clockTime } from "@/lib/time-format";
import type { AttRow } from "@/lib/use-attendance";

// Why late? Asked as soon as Start day lands after the grace period — from any
// Start day button (lib/use-eod.ts start: the server says the day waits for a
// reason) — and again on Home until it's answered. It can't be waved away:
// the lead sees the answer with today's attendance (Team today, Team ›
// Attendance, their activity).

const QUICK = ["Traffic", "Not well", "Doctor's visit", "Family matter", "Power or internet cut", "Personal work"];
const lateWords = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export function LateReasonDialog({ row, onSend }: { row: AttRow; onSend: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  // what the late start counts as (the server's classification)
  const counts = row.status === "absent" ? "This counts as absent for today."
    : row.status === "half_absent" ? "This counts as a half-day absence."
    : row.excused && row.reason === "permission" ? "A morning permission covers it."
    : "This counts as a late start.";
  const when = row.checkInAt
    ? `You started at ${clockTime(row.checkInAt)}${row.lateMinutes ? `, ${lateWords(row.lateMinutes)} after the office opened` : ""}.`
    : "You started late today.";
  const ready = note.trim().length >= 2;
  async function send() {
    if (!ready) { toast.error("Write a few words about why you started late."); return; }
    setSending(true);
    try {
      await onSend(note.trim());
      toast.success("Sent to your lead.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send that. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }
  return (
    <Modal title="Why are you starting late?" onClose={() => {}} locked>
      <div className="lr">
        <p className="lr-when">{when} <b>{counts}</b></p>
        <div className="lr-quick" role="group" aria-label="Common reasons">
          {QUICK.map((q) => (
            <button key={q} type="button" className={"lr-chip" + (note === q ? " on" : "")} aria-pressed={note === q} onClick={() => setNote(q)}>{q}</button>
          ))}
        </div>
        <textarea className="lr-note" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} autoFocus
          placeholder="Or tell your lead in your own words" aria-label="Why you're starting late"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }} />
        <div className="lr-foot">
          <span>Your lead sees this with today's attendance.</span>
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !ready}>{sending ? "Sending…" : "Send to my lead"}</button>
        </div>
      </div>
    </Modal>
  );
}
