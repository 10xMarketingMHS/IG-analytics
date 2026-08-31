import type { Editor, Task } from "@/lib/types";

// ---- Points Formula (locked spec) — timeliness only, no efficiency/hours- ----
// worked component. base_points is an admin-set value per content format
// (Reels/Poster/etc. — see Settings → Task Settings → Points per format),
// independent of that format's time budget; tasks with no resolved format
// fall back to 1. Bounded: a single task can cost at most its own full base
// value, in either direction.
//   on/before due date -> +100% · 1 day late -> +50% · 2 days late -> 0%
//   3+ days late -> -100% (flat, doesn't get worse)
// No due date is treated as on-time (nothing to be late against).
//
// Shared by the Media House Leaders board, Progress Path, and My Day's "your
// rank" widget — one implementation so all three can never quietly disagree.

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export function taskPoints(t: Task): number {
  const base = t.content_format_points != null ? Number(t.content_format_points) : 1;
  if (!t.completed_at) return 0;
  if (!t.due_date) return base;
  const daysLate = daysBetween(t.due_date, ymd(new Date(t.completed_at)));
  if (daysLate <= 0) return base;
  if (daysLate === 1) return base * 0.5;
  if (daysLate === 2) return 0;
  return -base;
}

// ---- Per-window ranking (My Day's "Your Score" widget) ----
// Same points formula, summed over completed tasks whose completion day
// falls within [fromYmd, toYmd] inclusive — reused for Today / This week /
// This month windows. Tie-break mirrors Media House Leaders: points, then
// volume completed (more tasks finished for the same score ranks higher).
type RankRow = { editorId: string; points: number; completed: number };

function rankRowsInRange(editors: Editor[], tasks: Task[], fromYmd: string, toYmd: string): RankRow[] {
  return editors
    .map((e) => {
      const own = tasks.filter((t) => {
        if (t.editor_id !== e.id || !t.completed_at) return false;
        const day = ymd(new Date(t.completed_at));
        return day >= fromYmd && day <= toYmd;
      });
      return { editorId: e.id, points: own.reduce((s, t) => s + taskPoints(t), 0), completed: own.length };
    })
    .sort((a, b) => b.points - a.points || b.completed - a.completed);
}

// One person's standing in a window: their points/completed count always come
// back (even at 0), but `rank` is null until they've actually completed
// something in that window — matching how the Media House Leaders board
// itself only ranks editors with completed work, everyone else sits unranked.
export function myRankInRange(
  editors: Editor[],
  tasks: Task[],
  fromYmd: string,
  toYmd: string,
  editorId: string | null,
): { points: number; completed: number; rank: number | null; totalRanked: number } {
  const rows = rankRowsInRange(editors, tasks, fromYmd, toYmd);
  const ranked = rows.filter((r) => r.completed > 0);
  const mine = editorId ? rows.find((r) => r.editorId === editorId) : undefined;
  const rank = mine && mine.completed > 0 ? ranked.findIndex((r) => r.editorId === editorId) + 1 : null;
  return { points: mine?.points ?? 0, completed: mine?.completed ?? 0, rank, totalRanked: ranked.length };
}
