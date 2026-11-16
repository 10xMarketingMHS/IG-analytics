// Goal periods for the twice-a-month reviews: Review 1 (1st–15th), Review 2
// (16th–month end) or the full month. Goal Setting stores one monthly target
// per content type (JC); a review period gets half of it. The server scores
// each period as a month of its own (GET /goals/performance-all: people for the
// month, periods.h1 / .h2 for the reviews) — its goal (periodGoal), the work
// done in those days, and the time filling the goals it missed.

export type Period = "h1" | "h2" | "m";
// goalAdjusted: the month's goal after approved leave (what the score counts
// against); periodGoal: this period's (the month's, or a review's share of it);
// actualJC: done in the period; the time filling its missed jobs (team goal
// credit and Other work, server/src/goal-score.js rule 6): filled (jobs),
// creditHours, counted (the jobs that count with it), and ownHours (the hours
// of the jobs done toward it)
export type PerfRow = {
  contentFormatId: string; name: string; goalJC: number; goalAdjusted?: number; periodGoal?: number; actualJC: number; points: number;
  filled?: number; creditHours?: number; counted?: number; ownHours?: number;
};
export type GoalLine = {
  id: string; name: string; month: number; target: number; done: number;
  adj: { counted: number; creditHours: number; ownHours: number };
};

function lastDay(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
export function periodBounds(month: string, per: Period): [string, string] {
  const end = `${month}-${String(lastDay(month)).padStart(2, "0")}`;
  if (per === "h1") return [`${month}-01`, `${month}-15`];
  if (per === "h2") return [`${month}-16`, end];
  return [`${month}-01`, end];
}
export function monthName(month: string, style: "long" | "short" = "long") {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: style, ...(style === "long" ? { year: "numeric" } : {}) });
}
export function periodLabel(month: string, per: Period) {
  const mon = monthName(month, "short");
  if (per === "h1") return `1–15 ${mon}`;
  if (per === "h2") return `16–${lastDay(month)} ${mon}`;
  return monthName(month);
}
// The review period today falls in, for the current month.
export const currentPeriod = (): Period => (new Date().getDate() <= 15 ? "h1" : "h2");

// Job counts to one decimal: a review period's target is half a goal (2.5), and
// adding or taking such numbers leaves float dust (17.099999999999998).
export const tenths = (n: number) => Math.round(n * 10) / 10;

// rows: the period's own (the server's people, or periods.h1 / .h2)
export function goalLines(rows: PerfRow[], per: Period): GoalLine[] {
  return rows
    .map((r) => {
      // the goal after approved leave, like the leaderboard and Management Performance
      const goal = r.goalAdjusted ?? r.goalJC;
      const first = tenths(goal / 2);
      const target = tenths(r.periodGoal ?? (per === "h1" ? first : per === "h2" ? goal - first : goal));
      const done = r.actualJC;
      const adj = { counted: r.counted ?? Math.min(done, target), creditHours: r.creditHours ?? 0, ownHours: r.ownHours ?? 0 };
      return { id: r.contentFormatId, name: r.name, month: tenths(goal), target, done, adj };
    })
    .filter((l) => l.target > 0);
}

// Achievement counts each goal only up to its own target, so overdoing one
// type can't hide a miss on another (the same rule as the goal score).
export function achievement(lines: GoalLine[]) {
  const target = tenths(lines.reduce((s, l) => s + l.target, 0));
  const done = tenths(lines.reduce((s, l) => s + Math.min(l.done, l.target), 0));
  return { target, done, x: target ? done / target : 0, missed: lines.filter((l) => l.done < l.target).length };
}

export type Band = { label: string; tone: "good" | "warn" | "bad" };
export const bandOf = (x: number): Band =>
  x >= 0.8 ? { label: "On track", tone: "good" } : x >= 0.5 ? { label: "Behind", tone: "warn" } : { label: "Critical", tone: "bad" };
export const pctText = (x: number) => `${Math.round(x * 100)}%`;
