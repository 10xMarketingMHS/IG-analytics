import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useBreakState } from "@/lib/break-context";
import { desktopState } from "@/lib/chat-alerts";
import { useEodState } from "@/lib/eod-context";
import { clockTime } from "@/lib/time-format";
import { useOrg } from "@/lib/use-org";
import { dueBreaks } from "@/lib/work-calendar";
import { useWorkspaces } from "@/lib/workspaces-context";
import "./break-prompt.css";

// At each break time (Settings › General › Work calendar), anyone who has
// started their day and isn't on a break is asked "Are you taking a break
// now?": Yes starts the break; no answer in 30 seconds starts it too (they've
// stepped away); closing it keeps them working. Asked once per break a day,
// however many Echo windows are open; not when they're already on a break or
// have no break time left. While Echo isn't in front, a desktop pop-up says so
// too (once this browser allows Echo's notifications).

const WAIT_SECONDS = 30;
type Due = ReturnType<typeof dueBreaks>[number];

// The breaks already asked about today, across windows (and kept in memory
// where this browser won't store them).
const askedHere = new Set<string>();
const ASKED_KEY = "echo:break-asked";
function wasAsked(key: string) {
  if (askedHere.has(key)) return true;
  try { return (JSON.parse(localStorage.getItem(ASKED_KEY) ?? "[]") as string[]).includes(key); } catch { return false; }
}
function markAsked(key: string) {
  askedHere.add(key);
  try {
    const day = key.slice(0, 10);
    const kept = (JSON.parse(localStorage.getItem(ASKED_KEY) ?? "[]") as string[]).filter((k) => k.startsWith(day));
    localStorage.setItem(ASKED_KEY, JSON.stringify([...new Set([...kept, key])]));
  } catch { /* this browser won't keep it: this window still remembers */ }
}
const clockOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
  return clockTime(d);
};

export function BreakPrompt() {
  const { user } = useAuth();
  const { org } = useOrg();
  const { active } = useWorkspaces();
  const { session } = useEodState();
  const { status, displayRemaining, start } = useBreakState();
  const [ask, setAsk] = useState<Due | null>(null);
  const [left, setLeft] = useState(WAIT_SECONDS);
  const deadline = useRef(0);
  const starting = useRef(false);
  // the latest break state, read by the 15-second check without restarting it
  const breakRef = useRef({ onBreak: false, left: 1 });
  breakRef.current = { onBreak: !!status?.onBreak, left: displayRemaining ?? status?.remainingSeconds ?? 0 };

  // Someone whose breaks are tracked and who is at work now: an editor who has
  // started their day (the people the break button is for).
  const atWork = !!user && !user.viewingAs && active?.role === "editor" && !!session && !!status && !status.unlinked;
  const calendar = org?.calendar;

  // Every 15 seconds: is it a break time nobody's been asked about yet?
  useEffect(() => {
    if (!atWork || ask) return;
    const check = () => {
      const due = dueBreaks(calendar).find((d) => !wasAsked(d.key));
      if (!due) return;
      markAsked(due.key);
      // already on a break, or none left today: nothing to ask
      if (breakRef.current.onBreak || breakRef.current.left <= 0) return;
      deadline.current = Date.now() + WAIT_SECONDS * 1000;
      setLeft(WAIT_SECONDS);
      setAsk(due);
      if ((document.hidden || !document.hasFocus()) && desktopState() === "granted") {
        try {
          const n = new Notification(`${due.l} — are you taking a break now?`, {
            body: `Your break starts by itself in ${WAIT_SECONDS} seconds. Still working? Open Echo and close the question.`,
            tag: `echo-break-${due.key}`, icon: "/app-icon.svg",
          });
          n.onclick = () => { window.focus(); n.close(); };
        } catch { /* this browser won't show one */ }
      }
    };
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [atWork, ask, calendar]);

  async function takeBreak(byItself: boolean) {
    if (starting.current || !ask) return;
    starting.current = true;
    const what = ask.l.toLowerCase();
    setAsk(null);
    try {
      await start();
      toast.success(byItself ? `No answer, so your ${what} has started. Your task timers are paused.` : `Enjoy your ${what}. Your task timers are paused.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't start your break.");
    } finally {
      starting.current = false;
    }
  }
  const keepWorking = () => setAsk(null);

  // The 30 seconds, counted from when it was asked (a background window's
  // timers may run late: the deadline holds).
  useEffect(() => {
    if (!ask) return;
    const tick = () => {
      const s = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) takeBreak(true);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  // On a break some other way, or the day ended: nothing to ask.
  useEffect(() => { if (ask && (!atWork || status?.onBreak)) setAsk(null); }, [ask, atWork, status?.onBreak]);
  // Escape keeps them working.
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") keepWorking(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask]);

  if (!ask) return null;
  const frac = left / WAIT_SECONDS;
  return (
    <div className="bp-scrim" role="dialog" aria-modal="true" aria-labelledby="bp-title" aria-describedby="bp-note">
      <div className="bp-card">
        <button type="button" className="bp-x" onClick={keepWorking} aria-label="Close and keep working">×</button>
        <div className="bp-eyebrow">{ask.l} · {clockOf(ask.at)}</div>
        <h2 id="bp-title" className="bp-title">Are you taking a break now?</h2>
        <div className="bp-ring" aria-hidden>
          <svg viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" className="bp-track" />
            <circle cx="60" cy="60" r="52" className="bp-arc" strokeDasharray={`${(2 * Math.PI * 52 * frac).toFixed(1)} 999`} transform="rotate(-90 60 60)" />
          </svg>
          <b>{left}</b>
        </div>
        <p id="bp-note" className="bp-note" aria-live="polite">
          No answer in {left} second{left === 1 ? "" : "s"} starts your break and pauses your task timers.
        </p>
        <div className="bp-actions">
          {/* focus on No: an Enter meant for something else never starts a break */}
          <button type="button" className="bp-btn" onClick={keepWorking} autoFocus>No, I'm working</button>
          <button type="button" className="bp-btn pri" onClick={() => takeBreak(false)}>Yes, start my break</button>
        </div>
      </div>
    </div>
  );
}
