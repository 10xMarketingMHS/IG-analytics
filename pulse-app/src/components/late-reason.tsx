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
// Attendance, their activity). A start after the office closed asks why they
// weren't in during office hours instead.

const QUICK = ["Traffic", "Not well", "Doctor's visit", "Family matter", "Power or internet cut", "Personal work"];
const QUICK_MISSED = ["Not well", "Doctor's visit", "Family matter", "Travel", "Power or internet cut", "Personal work"];
const lateWords = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
// "18:00" → 6:00 PM
const clockOfHHMM = (hhmm: string) => { const d = new Date(); const [h, m] = hhmm.split(":").map(Number); d.setHours(h, m, 0, 0); return clockTime(d); };

export function LateReasonDialog({ row, onSend }: { row: AttRow; onSend: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  // in after the office closed: the office hours were missed, not started late
  const after = row.afterHours ?? null;
  // what the late start counts as (the server's classification)
  const counts = row.status === "absent" ? "This counts as absent for today."
    : row.status === "half_absent" ? "This counts as a half-day absence."
    : row.excused && row.reason === "permission" ? "A morning permission covers it."
    : "This counts as a late start.";
  const when = !row.checkInAt ? (after ? "You weren't in during office hours today." : "You started late today.")
    : after ? `You started at ${clockTime(row.checkInAt)}, after the office closed at ${clockOfHHMM(after)}.`
    : `You started at ${clockTime(row.checkInAt)}${row.lateMinutes ? `, ${lateWords(row.lateMinutes)} after the office opened` : ""}.`;
  const quick = after ? QUICK_MISSED : QUICK;
  const ready = note.trim().length >= 2;
  async function send() {
    if (!ready) { toast.error(after ? "Write a few words about why you weren't in." : "Write a few words about why you started late."); return; }
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
    <Modal title={after ? "Why weren't you in during office hours?" : "Why are you starting late?"} onClose={() => {}} locked>
      <div className="lr">
        <p className="lr-when">{when} <b>{counts}</b></p>
        <div className="lr-quick" role="group" aria-label="Common reasons">
          {quick.map((q) => (
            <button key={q} type="button" className={"lr-chip" + (note === q ? " on" : "")} aria-pressed={note === q} onClick={() => setNote(q)}>{q}</button>
          ))}
        </div>
        <textarea className="lr-note" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} autoFocus
          placeholder="Or tell your lead in your own words" aria-label={after ? "Why you weren't in during office hours" : "Why you're starting late"}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }} />
        <div className="lr-foot">
          <span>Your lead sees this with today's attendance.</span>
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !ready}>{sending ? "Sending…" : "Send to my lead"}</button>
        </div>
      </div>
    </Modal>
  );
}

// Start day outside office hours (past closing, or a day the office is closed):
// a yes first. The words are the server's — what starting now means for the
// day (absent, leave kept, a day off) — and "Not now" starts nothing.
export function OutsideHoursDialog({ message, onAnswer }: { message: string; onAnswer: (go: boolean) => void }) {
  return (
    <Modal title="Working outside office hours?" onClose={() => onAnswer(false)}>
      <div className="lr">
        <p className="lr-when">{message}</p>
        <div className="lr-foot">
          <span />
          <button type="button" className="btn" onClick={() => onAnswer(false)}>Not now</button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => onAnswer(true)}>Yes, continue</button>
        </div>
      </div>
    </Modal>
  );
}
