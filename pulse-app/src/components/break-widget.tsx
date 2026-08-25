import { useAuth } from "@/lib/auth-context";
import { useBreak } from "@/lib/use-break";
import { ApiError } from "@/lib/api";
import { toast } from "sonner";

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

// Floating bottom-right pause/resume control for the shared daily break
// budget (lunch + tea breaks). Stays visible for every logged-in user —
// an admin-only login with no linked editor sees a disabled, explained
// state rather than the widget just vanishing. Mounted once in the app
// shell so it's available from any page, not just the Task Board.
export function BreakWidget() {
  const { user } = useAuth();
  const { status, displayRemaining, busy, start, end } = useBreak();

  if (!user || !status) return null;

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
