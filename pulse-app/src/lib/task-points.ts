import type { Editor, Task } from "@/lib/types";

// Admin tasks are an admin-only personal category with no scoring — they must
// never contribute points or count toward completed volume in any ranking.
// Excluded (not scored as zero) at every aggregation, here and in leaderboard.tsx.
export const isScorableTask = (t: Task): boolean => t.task_type !== "admin";

// Who takes part in the Task Points rankings. Managers and Team Leads oversee
// the work, so by default they stay out; a Super Admin can switch anyone in or
// out on Team › Roster (editor.in_task_score — null follows the position).
// People left out keep their tasks; they just aren't ranked. Applied at every
// ranking: here, in leaderboard.tsx and in team-panel.tsx.
const LEADS = /\b(manager|team lead|tl)\b/i;
export const leadsByPosition = (designation: string | null | undefined): boolean => LEADS.test(designation ?? "");
export const countsInTaskScore = (e: Pick<Editor, "designation" | "in_task_score">): boolean =>
  e.in_task_score ?? !leadsByPosition(e.designation);

// ---- Points Formula (locked spec) ----
// base_points is an admin-set value per content format (Reels/Poster/etc. —
// see Settings → Task Settings → Points per format), independent of that
// format's time budget; tasks with no resolved format fall back to 1.
//
//   Final = base_points × timelinessMultiplier × reworkMultiplier
//
// TIMELINESS (how late it was finished):
//   on/before due date -> +100% · 1 day late -> +50% · 2 days late -> 0%
//   3+ days late -> -100% (flat, doesn't get worse)
//   No due date is treated as on-time (nothing to be late against).
//   Time spent waiting for a reviewer doesn't count: lateness is measured at
//   workedUntil() — approval time minus every review wait.
// REWORK (how many review send-backs it took — the task.revision count):
//   see reworkMultiplier below.
//
// Rework only scales earned (positive) points down; it never softens the
// 3+-days-late penalty, so a late task with many send-backs can't lose less
// than one with none. Evaluated at completion using the revision count then.
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

// Rework penalty by revision count (task.revision — the number of times a
// review was sent back, starting at 1 for a never-reworked task). A positive
// fraction ≤ 1 that scales the whole point value down as rework piles up:
//   revision ≤ 3       -> 100% (no penalty)
//   3 < revision ≤ 5   -> 70%
//   5 < revision ≤ 7   -> 50%
//   revision > 7       -> 20% (floor — never lower, however many more reworks)
// null/0 (no rework history) is the unpenalized default.
export function reworkMultiplier(revision: number | null | undefined): number {
  const r = revision ?? 0;
  if (r <= 3) return 1;
  if (r <= 5) return 0.7;
  if (r <= 7) return 0.5;
  return 0.2;
}

// The moment a task's lateness is measured at, with every wait for a reviewer
// taken out — when it would have been finished had each review been instant.
// Completed: approval time. In Review: frozen at submission. Otherwise: now.
export function workedUntil(t: Task, now: Date = new Date()): Date {
  const at = t.status === "done" && t.completed_at ? new Date(t.completed_at)
    : t.status === "review" && t.review_started_at ? new Date(t.review_started_at)
    : now;
  return new Date(at.getTime() - Number(t.review_wait_seconds ?? 0) * 1000);
}

// Days past the due date at workedUntil(); 0 or less is on time (no due date: 0).
export function lateDays(t: Task, now?: Date): number {
  return t.due_date ? daysBetween(t.due_date, ymd(workedUntil(t, now))) : 0;
}

export function taskPoints(t: Task): number {
  const base = t.content_format_points != null ? Number(t.content_format_points) : 1;
  if (!t.completed_at) return 0;
  const rework = reworkMultiplier(t.revision);
  const daysLate = lateDays(t);
  if (daysLate <= 0) return base * rework;
  if (daysLate === 1) return base * 0.5 * rework;
  if (daysLate === 2) return 0;
  return -base;
}

// ---- Per-window ranking (My Day's "Your Score" widget) ----
// Same points formula, summed over completed tasks whose completion day
// falls within [fromYmd, toYmd] inclusive — reused for Today / This week /
// This month windows. Tie-break mirrors Media House Leaders: points, then
// volume completed (more tasks finished for the same score ranks higher).
type RankRow = { editorId: string; points: number; completed: number };

function rowInRange(editorId: string, tasks: Task[], fromYmd: string, toYmd: string): RankRow {
  const own = tasks.filter((t) => {
    if (t.editor_id !== editorId || !t.completed_at || !isScorableTask(t)) return false;
    const day = ymd(new Date(t.completed_at));
    return day >= fromYmd && day <= toYmd;
  });
  return { editorId, points: own.reduce((s, t) => s + taskPoints(t), 0), completed: own.length };
}

function rankRowsInRange(editors: Editor[], tasks: Task[], fromYmd: string, toYmd: string): RankRow[] {
  return editors
    .filter(countsInTaskScore)
    .map((e) => rowInRange(e.id, tasks, fromYmd, toYmd))
    .sort((a, b) => b.points - a.points || b.completed - a.completed);
}

// The top editors in a window, ranked by Task Points — same aggregation the
// Media House Leaders board uses, sliced for the My Day "Top Performer" ticker.
// Only net-positive performers appear (points > 0): this is a celebratory
// banner, so someone sitting at 0, or net-negative from finishing everything
// late, is left off rather than paraded as a "top performer".
export function topEditorsInRange(
  editors: Editor[],
  tasks: Task[],
  fromYmd: string,
  toYmd: string,
  limit: number,
): RankRow[] {
  return rankRowsInRange(editors, tasks, fromYmd, toYmd)
    .filter((r) => r.points > 0)
    .slice(0, limit);
}

// One person's standing in a window: their points/completed count always come
// back (even at 0), but `rank` is null until they've actually completed
// something in that window — matching how the Media House Leaders board
// itself only ranks editors with completed work, everyone else sits unranked.
// Someone left out of the task score (countsInTaskScore) still sees their own
// points, with `counted` false and never a rank.
export function myRankInRange(
  editors: Editor[],
  tasks: Task[],
  fromYmd: string,
  toYmd: string,
  editorId: string | null,
): { points: number; completed: number; rank: number | null; totalRanked: number; counted: boolean } {
  const rows = rankRowsInRange(editors, tasks, fromYmd, toYmd);
  const ranked = rows.filter((r) => r.completed > 0);
  const me = editorId ? editors.find((e) => e.id === editorId) : undefined;
  const counted = !me || countsInTaskScore(me);
  const mine = editorId ? (counted ? rows.find((r) => r.editorId === editorId) : rowInRange(editorId, tasks, fromYmd, toYmd)) : undefined;
  const rank = counted && mine && mine.completed > 0 ? ranked.findIndex((r) => r.editorId === editorId) + 1 : null;
  return { points: mine?.points ?? 0, completed: mine?.completed ?? 0, rank, totalRanked: ranked.length, counted };
}
