import type { Task } from "@/lib/types";
import { ymd } from "@/lib/task-points";

// Goal periods for the twice-a-month reviews: Review 1 (1st–15th), Review 2
// (16th–month end) or the full month. Goal Setting stores one monthly target
// per content type (JC); a review period gets half of it, Review 1 taking the
// odd one (ceil). Whole-month "done" is the server's count (GET
// /goals/performance, tasks approved that month); the halves are counted here
// from the same tasks — done, of that type, approved in those days.

export type Period = "h1" | "h2" | "m";
export type PerfRow = { contentFormatId: string; name: string; goalJC: number; actualJC: number; points: number };
export type GoalLine = { id: string; name: string; month: number; target: number; done: number };

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

// Done tasks per content type for one person, approved between two dates (inclusive).
export function doneByType(tasks: Task[], editorId: string, from: string, to: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (t.editor_id !== editorId || t.status !== "done" || !t.content_format_id || !t.completed_at) continue;
    const d = ymd(new Date(t.completed_at));
    if (d >= from && d <= to) m.set(t.content_format_id, (m.get(t.content_format_id) ?? 0) + 1);
  }
  return m;
}

export function goalLines(rows: PerfRow[], per: Period, halfCounts?: Map<string, number>): GoalLine[] {
  return rows
    .map((r) => {
      const first = Math.ceil(r.goalJC / 2);
      const target = per === "h1" ? first : per === "h2" ? r.goalJC - first : r.goalJC;
      const done = per === "m" ? r.actualJC : halfCounts?.get(r.contentFormatId) ?? 0;
      return { id: r.contentFormatId, name: r.name, month: r.goalJC, target, done };
    })
    .filter((l) => l.target > 0);
}

// Achievement counts each goal only up to its own target, so overdoing one
// type can't hide a miss on another (the same rule as the goal score).
export function achievement(lines: GoalLine[]) {
  const target = lines.reduce((s, l) => s + l.target, 0);
  const done = lines.reduce((s, l) => s + Math.min(l.done, l.target), 0);
  return { target, done, x: target ? done / target : 0, missed: lines.filter((l) => l.done < l.target).length };
}

export type Band = { label: string; tone: "good" | "warn" | "bad" };
export const bandOf = (x: number): Band =>
  x >= 0.8 ? { label: "On track", tone: "good" } : x >= 0.5 ? { label: "Behind", tone: "warn" } : { label: "Critical", tone: "bad" };
export const pctText = (x: number) => `${Math.round(x * 100)}%`;
