import { useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { useBreakState } from "@/lib/break-context";
import { ApiError } from "@/lib/api";
import { OFFICE_CLOSE_HOUR } from "@/lib/task-timing";
import { toast } from "sonner";

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

// Floating bottom-right pause/resume control for the shared daily break
// budget (lunch + tea breaks). Only relevant where task timers actually run,
// so it only shows on the Task Board — mounted once in the app shell, but
// self-hides everywhere else rather than following the user to every page.
// Collapses to a bare circle when idle (hover, or an active break, reveals
// the label) so it doesn't compete for attention outside that one context.
export function BreakWidget() {
  const { user } = useAuth();
  const { status, displayRemaining, busy, start, end } = useBreakState();
  const location = useLocation();

  if (location.pathname !== "/tasks") return null;
  if (!user || !status) return null;
  // Breaks are a workday concept — no point offering "start a break" once
  // office hours are over. Exception: someone already mid-break needs to
  // stay able to end it, so this only hides the *offer*, never a break
  // that's already running.
  if (new Date().getHours() >= OFFICE_CLOSE_HOUR && !status.onBreak) return null;

  if (status.unlinked) {
    return (
      <div className="break-widget" title="Ask an admin to link your login to a team member to track breaks.">
        <div className="break-widget-label">No break tracking — account not linked to a team member</div>
        <button type="button" className="break-widget-btn" disabled>⏸</button>
      </div>
    );
  }

  const remaining = displayRemaining ?? status.remainingSeconds;
  const outOfBreak = !status.onBreak && remaining <= 0;

  async function handleClick() {
    try {
      if (status!.onBreak) {
        await end();
        toast.success("Back to work — timers resumed.");
      } else {
        await start();
        toast.success("On break — your task timers are paused.");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update your break.");
    }
  }

  return (
    <div className={"break-widget" + (status.onBreak ? " on" : "")}>
      <div className="break-widget-label">
        {status.onBreak ? `⏸ On break — ${fmt(remaining)} left` : outOfBreak ? "No break time left today" : `${fmt(remaining)} break left today`}
      </div>
      <button
        type="button"
        className={"break-widget-btn" + (status.onBreak ? " pause" : " play")}
        disabled={busy || (!status.onBreak && outOfBreak)}
        onClick={handleClick}
        title={status.onBreak ? "Resume — end your break" : "Pause — start a break"}
      >
        {status.onBreak ? "▶" : "⏸"}
      </button>
    </div>
  );
}
