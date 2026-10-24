import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useEodState } from "@/lib/eod-context";
import { StartCancelled } from "@/lib/use-eod";
import { useAuth } from "@/lib/auth-context";
import { clockTime } from "@/lib/time-format";
import { Icon } from "@/components/icon";
import { minutesOf, type AttToday } from "@/lib/use-attendance";
import { LeavePanel } from "@/pages/leave";
import type { Task } from "@/lib/types";

// Start of day on Home (Pulse Redesign v7), for team leads and editors:
//   before check-in  — the "Start your day" card: today's plan, Start day,
//                      "Started earlier? Request a correction", and what's on
//                      your list today;
//   checked in       — a slim bar: on time / late, the check-in time, the
//                      plan, Undo (first 5 minutes) and End day (no discipline
//                      points: those are for leads),
//                      which opens the wrap-up panel;
//   checked out      — one line: the day closed and the hours in office
//                      (Ask for leave and the CL / SL line on the card open
//                      the leave side panel; after that it's the top bar's Leave).
// Start day is the check-in and opens the work day (it replaced Start Work).

const fmtHM = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const sameDay = (iso: string, ymd: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` === ymd;
};

export function StartDaySection({
  att, attMissing, firstName, today, myTasks, completedToday, pointsToday, preview, onOpenReports, onOpenTask,
}: {
  att: AttToday | null;
  attMissing: boolean;
  firstName: string;
  today: string;
  myTasks: Task[];
  completedToday: number;
  pointsToday: number;
  preview: boolean;
  onOpenReports: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { session, loading: dayLoading, start, checkOut, undoStart, busy, openSod, refresh, lateAsk, askLateReason } = useEodState();
  const { user } = useAuth();
  const [plan, setPlan] = useState("");
  const [corrOpen, setCorrOpen] = useState(false);
  const [corrTime, setCorrTime] = useState("");
  const [corrNote, setCorrNote] = useState("");
  const [ending, setEnding] = useState(false);
  const [wrap, setWrap] = useState("");
  const [sending, setSending] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  // which tab the panel opens on: Ask for leave, or Permission
  const [leaveTab, setLeaveTab] = useState<"apply" | "permission">("apply");
  const openPanel = (t: "apply" | "permission") => { setLeaveTab(t); setLeaveOpen(true); };
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The banner's End day button opens the wrap-up here.
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const open = () => {
      setEnding(true);
      window.setTimeout(() => barRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    };
    window.addEventListener("pulse:end-day", open);
    return () => window.removeEventListener("pulse:end-day", open);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // A late start nobody said why about yet (the page reloaded, or the day was
  // started some other way): ask once on Home; the bar keeps a link to it.
  const lateDue = !preview && !user?.viewingAs && !!att?.me?.lateNoteNeeded;
  const askedOnce = useRef(false);
  useEffect(() => {
    if (!lateDue || lateAsk || askedOnce.current || !att?.me) return;
    askedOnce.current = true;
    askLateReason(att.me);
  }, [lateDue, lateAsk, att?.me, askLateReason]);

  const s = att?.settings;
  const me = att?.me ?? null;
  const open = att?.opening ?? null;
  const close = att?.closing ?? null;
  const graceMin = s?.graceMinutes ?? 10;
  // Permissions this month (null before the database has them).
  const perms = att?.permissions ?? null;
  const halfAt = s?.halfDayAt ?? "11:30";
  const absentAt = s?.autoAbsentAt ?? "13:30";
  const autoMarks = s?.autoAbsentEnabled ?? true;
  const permLine = perms ? `${perms.left} of ${perms.perMonth} permission${perms.perMonth === 1 ? "" : "s"} left this month` : null;
  const askLink = perms && !preview ? (
    <button type="button" className="sd-link" onClick={() => openPanel("permission")}>Ask for a permission</button>
  ) : null;
  // Leave (pages/leave.tsx), once a manager has started counting: Ask for
  // leave and the CL / SL line on the card, Leave on the bars — a side panel.
  const leave = att?.leave?.counting && !preview ? att.leave : null;
  const leaveLink = leave ? (
    <button type="button" className="sd-link sd-ic" onClick={() => openPanel("apply")}><Icon name="event_available" size={16} />Ask for leave</button>
  ) : null;
  const bal = leave?.balance;
  const leaveLine = leave && bal ? (
    <button type="button" className="sd-leave-line" onClick={() => openPanel("apply")} title="Open your leave">
      <span><i className="cl" />CL <b>{fmtN(bal.CL.left)} of {fmtN(bal.CL.total)}</b> left</span>
      <span><i className="sl" />SL <b>{fmtN(bal.SL.left)} of {fmtN(bal.SL.total)}</b> left</span>
      {leave.waiting > 0 && <span>· {leave.waiting} request{leave.waiting === 1 ? "" : "s"} waiting</span>}
    </button>
  ) : null;
  const leaveForm = leaveOpen ? <LeavePanel startTab={leaveTab} onClose={() => setLeaveOpen(false)} /> : null;
  const now = new Date(nowMs);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // A preview (an admin seeing another role's Home) always shows the card a
  // team member sees before Start day.
  const checkedIn = !preview && (!!me?.checkInAt || (!!session && !me?.checkOutAt));
  const closed = !preview && !!me?.checkOutAt && !session;

  // First visit: nothing known yet about your day — a quiet line, not the
  // wrong card for a second.
  if (!preview && !att && !attMissing && dayLoading) {
    return <section className="sd-bar closed sd-loading" aria-label="Your day" aria-busy="true"><span>Loading your day…</span></section>;
  }

  // ---- Before check-in: the Start your day card ----
  if (!checkedIn && !closed) {
    const late = open ? nowMin - minutesOf(open) : 0;
    const lateText = late >= 60 ? `${Math.floor(late / 60)}h ${late % 60}m` : `${late}m`;
    const sub = !open ? { t: "The office is closed today", tone: "" }
      : close && nowMin >= minutesOf(close) ? { t: `The office closed at ${clockTime(atToday(close))} · starting now is after office hours${autoMarks ? " (counts as absent)" : ""}`, tone: "bad" }
      : late < 0 ? { t: `Office opens at ${clockTime(atToday(open))} · you're early`, tone: "good" }
      : late <= graceMin ? { t: `Office opened at ${clockTime(atToday(open))} · you're on time`, tone: "good" }
      : autoMarks && nowMin >= minutesOf(absentAt) ? { t: `Starting now counts as absent (after ${clockTime(atToday(absentAt))})`, tone: "bad" }
      : autoMarks && nowMin >= minutesOf(halfAt) ? { t: `Starting now counts as a half-day absence (after ${clockTime(atToday(halfAt))})`, tone: "bad" }
      : perms && perms.left > 0 ? { t: `Starting now is ${lateText} late · a morning permission covers it (${perms.left} left this month)`, tone: "rev" }
      : { t: `Office opened at ${clockTime(atToday(open))} · starting now is ${lateText} late`, tone: "warn" };
    const marked = me && me.markedBy && (me.status === "leave" || me.status === "half_day")
      ? (me.status === "leave" ? "Your lead marked you on leave today." : "Your lead marked you on half-day leave.") : null;
    const list = myTasks.slice(0, 4);
    async function startDay() {
      if (preview) { toast("Preview — Start day is for the person themselves."); return; }
      try {
        await start(plan.trim() || undefined);
        const lateNow = open ? nowMin - minutesOf(open) : 0;
        const afterClose = !!open && !!close && nowMin >= minutesOf(close);
        const covered = open && lateNow > graceMin && perms && perms.left > 0 && !(autoMarks && nowMin >= minutesOf(halfAt));
        toast.success(`Day started at ${clockTime(new Date())}${afterClose ? " · after office hours" : covered ? " · morning permission used" : open && lateNow > graceMin ? " · marked late" : ""}`);
        setPlan("");
      } catch (e) {
        // "Not now" to working outside office hours: nothing started, nothing to say
        if (e instanceof StartCancelled) return;
        toast.error(e instanceof ApiError ? e.message : "Couldn't start your day. Check your connection and try again.");
      }
    }
    async function sendCorrection() {
      if (preview) { toast("Preview — corrections are for the person themselves."); return; }
      if (!/^\d{2}:\d{2}$/.test(corrTime)) { toast.error("Pick the time you started."); return; }
      setSending(true);
      try {
        await api("/attendance/correction-request", { method: "POST", body: JSON.stringify({ time: corrTime, note: corrNote.trim() || undefined }) });
        await refresh();
        window.dispatchEvent(new Event("pulse:attendance-changed"));
        toast.success("Correction request sent to your lead. You're checked in for now.");
        setCorrOpen(false);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Couldn't send that request.");
      } finally {
        setSending(false);
      }
    }
    return (
      <section className="sd-card" aria-label="Start your day">
        <div className="sd-main">
          <div className="sd-head">
            <span className="sd-tile"><Icon name="wb_sunny" size={22} /></span>
            <div>
              <h2>Start your day{firstName ? `, ${firstName}` : ""}</h2>
              <p className={"sd-sub " + sub.tone}>{sub.t}</p>
            </div>
          </div>
          {marked && <p className="sd-note">{marked}</p>}
          <textarea className="sd-plan" rows={2} value={plan} onChange={(e) => setPlan(e.target.value)} maxLength={1000}
            placeholder="Today's plan — what will you finish today?" aria-label="Today's plan" />
          <div className="sd-acts">
            <button type="button" className="sd-btn primary" onClick={startDay} disabled={busy}>
              <Icon name="login" size={17} />{busy ? "Starting…" : "Start day"}
            </button>
            {(s?.allowCorrections ?? true) && !attMissing && (
              <button type="button" className="sd-link" onClick={() => { setCorrOpen((o) => !o); setCorrTime(open ?? "09:00"); }}>
                Started earlier? Request a correction
              </button>
            )}
            {askLink}
            {leaveLink}
          </div>
          {permLine && <p className="sd-faint">{permLine}</p>}
          {leaveLine}
          {leaveForm}
          {corrOpen && (
            <div className="sd-corr">
              <label>I started at <input type="time" value={corrTime} onChange={(e) => setCorrTime(e.target.value)} /></label>
              <input type="text" className="sd-corr-note" value={corrNote} onChange={(e) => setCorrNote(e.target.value)} placeholder="Note for your lead (optional)" maxLength={500} />
              <button type="button" className="sd-btn" onClick={sendCorrection} disabled={sending}>{sending ? "Sending…" : "Send to my lead"}</button>
              <span className="sd-faint">You'll be checked in now; your lead approves the earlier time.</span>
            </div>
          )}
        </div>
        <div className="sd-side">
          <div className="sd-eyebrow">On your list today</div>
          {list.length === 0 ? <p className="sd-faint">Nothing on your list yet.</p> : (
            <ul className="sd-list">
              {list.map((t) => {
                const due = t.due_date == null ? "" : t.due_date < today ? "Overdue" : t.due_date === today ? "Today" : new Date(t.due_date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
                const tone = t.due_date == null ? "" : t.due_date < today ? "bad" : t.due_date === today ? "warn" : "";
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => onOpenTask(t.id)}>
                      <span className={"sd-dot " + tone} />
                      <span className="sd-title">{t.title}</span>
                      {due && <span className={"sd-due " + tone}>{due}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="sd-foot">
            <Icon name="lock" size={15} />
            {(s?.requireSod ?? true) ? "Task timers unlock after you start your day" : "Your lead sees your check-in time"}
          </div>
        </div>
      </section>
    );
  }

  // ---- Checked out: one line ----
  if (closed && me?.checkInAt && me.checkOutAt) {
    return (
      // eod-live: the day lock leaves it in colour and clickable (Reopen day, My reports)
      <section className="sd-bar closed eod-live" aria-label="Day closed">
        <Icon name="task_alt" size={18} className="sd-good" />
        <span><b>Day closed</b> · {clockTime(me.checkInAt)} – {clockTime(me.checkOutAt)} · {fmtHM(new Date(me.checkOutAt).getTime() - new Date(me.checkInAt).getTime())} in office · task timers paused</span>
        <span className="sd-grow" />
        <button type="button" className="sd-link" onClick={onOpenReports}>My reports</button>
        <button type="button" className="sd-btn primary" onClick={() => start().then(() => toast.success("Day reopened. Your task timers are running again.")).catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't reopen your day."))} disabled={busy}>{busy ? "Reopening…" : "Reopen day"}</button>
        {/* leave can be applied for whatever state today is in */}
        {leaveForm}
      </section>
    );
  }

  // ---- Checked in: the slim bar (and the End day panel) ----
  const inAt = me?.checkInAt ?? session?.startedAt ?? null;
  const late = me && me.status === "late" && !me.excused;
  const byPermission = !!me && me.status === "late" && me.excused && me.reason === "permission";
  const pill = late ? { t: `Late +${me!.lateMinutes >= 60 ? `${Math.floor(me!.lateMinutes / 60)}h ${me!.lateMinutes % 60}m` : `${me!.lateMinutes}m`}`, tone: "warn" }
    : byPermission ? { t: "Permission", tone: "rev" }
    : me?.status === "half_absent" ? { t: "Half day absent", tone: "bad" }
    : me?.status === "absent" ? { t: "Absent", tone: "bad" }
    : me?.status === "half_day" ? { t: "Half day", tone: "rev" }
    : { t: "On time", tone: "good" };
  // Discipline points aren't shown to the person themselves (only leads see
  // them, on Team today and Team › Attendance): the pill says how the day went.
  const missed = me?.status === "absent" || me?.status === "half_absent";
  const canUndo = !!me?.checkInAt && nowMs - new Date(me.checkInAt).getTime() < 5 * 60_000 && !preview;
  const inOfficeMs = inAt ? nowMs - new Date(inAt).getTime() : 0;
  async function closeDay() {
    if (preview) { toast("Preview — End day is for the person themselves."); return; }
    if ((s?.requireEodNote ?? false) && !wrap.trim()) { toast.error("Add a short wrap-up note first."); return; }
    try {
      await checkOut(wrap.trim());
      setEnding(false);
      setWrap("");
      toast.success("Day closed — see you tomorrow");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't close your day.");
    }
  }
  async function undo() {
    try {
      await undoStart();
      toast.success("Start day undone.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't undo Start day.");
    }
  }
  return (
    <section ref={barRef} className={"sd-bar" + (ending ? " open" : "")} aria-label="Your day">
      <div className="sd-barrow">
        <span className={"sd-pill " + pill.tone}><i />{pill.t}</span>
        <div className="sd-barmain">
          <b>
            {inAt ? `Checked in ${clockTime(inAt)}` : "Checked in"}
            {me?.afterHours ? " · after office hours" : late ? " · late start" : missed ? "" : byPermission ? " · morning permission used" : me?.excused ? " · late excused" : " · nice, on time"}
          </b>
          <span>{me?.planNote ? `Plan: ${me.planNote}` : "No plan added"}{me?.lateNote ? ` · ${me.afterHours ? "Not in" : "Late"}: “${me.lateNote}”` : ""}{me?.correctionStatus === "pending" && me.correctionAt ? ` · correction to ${clockTime(me.correctionAt)} waiting on your lead` : ""}{permLine ? ` · ${permLine}` : ""}</span>
        </div>
        <span className="sd-grow" />
        {lateDue && me && <button type="button" className="sd-link warn" onClick={() => askLateReason(me)}>{me.afterHours ? "Say why you weren't in" : "Say why you're late"}</button>}
        <button type="button" className="sd-link" onClick={openSod} title="Pick today's tasks and copy the Start of Day report for WhatsApp">Start of Day</button>
        <button type="button" className="sd-link" onClick={onOpenReports}>My reports</button>
        {askLink}
        {canUndo && <button type="button" className="sd-link" onClick={undo} disabled={busy}>Undo</button>}
        {!ending && (
          <button type="button" className="sd-btn" onClick={() => setEnding(true)}><Icon name="logout" size={17} />End day</button>
        )}
      </div>
      {leaveForm}
      {ending && (
        <div className="sd-end">
          <div className="sd-stats">
            <span><b>{completedToday} / {completedToday + myTasks.filter((t) => t.due_date != null && t.due_date <= today).length}</b><em>tasks done</em></span>
            <span><b>{Math.round(pointsToday)}</b><em>points today</em></span>
            <span><b>{fmtHM(inOfficeMs)}</b><em>in office so far</em></span>
          </div>
          <textarea className="sd-plan" rows={2} value={wrap} onChange={(e) => setWrap(e.target.value)} maxLength={2000}
            placeholder="Wrap-up — what did you finish, what's carrying over?" aria-label="Wrap-up" />
          <div className="sd-acts end">
            <span className="sd-faint">{(s?.requireEodNote ?? false) ? "A short wrap-up is needed to close your day." : "The wrap-up is optional."} Your End of Day report opens to copy.</span>
            <span className="sd-grow" />
            <button type="button" className="sd-btn" onClick={() => setEnding(false)}>Cancel</button>
            <button type="button" className="sd-btn primary" onClick={closeDay} disabled={busy}><Icon name="check" size={17} />{busy ? "Closing…" : "Close my day"}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// 2 or 1.5 (leave days)
const fmtN = (x: number) => String(Math.round(x * 10) / 10);

// "09:00" today → a Date (for clockTime).
function atToday(hhmm: string) {
  const d = new Date();
  const [h, m] = hhmm.split(":").map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

// Has this person a check-in today (for the Home role's SOD rules)?
export const checkedInToday = (att: AttToday | null, today: string) => !!att?.me?.checkInAt && sameDay(att.me.checkInAt, today);
