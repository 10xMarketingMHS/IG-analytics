import { fmtDuration, type EodDayTask, type EodSummary } from "@/lib/use-eod";
import { clockTime } from "@/lib/time-format";

export function eodTime(iso: string | null): string {
  if (!iso) return "—";
  return clockTime(iso);
}
function fmtDay(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function eodStatusLabel(t: EodDayTask): string {
  if (t.status === "done") return "Done";
  if (t.status === "review") return "In review";
  if (t.status === "in_progress") return t.onHold ? "On hold" : "In progress";
  return "To do";
}
// "Thumbnail · doctorfarmer"
export function eodTaskMeta(t: EodDayTask): string {
  return [t.format, t.channel].filter(Boolean).join(" · ");
}

// "Completed today" and "due today" are different sets of tasks, so the due-today
// figure gets its own line rather than being the bottom half of a fraction.
export function dueTodayLine(s: EodSummary): string | null {
  if (!s.dueToday) return null;
  return `Due today: ${s.dueTodayDone ?? 0} of ${s.dueToday} done`;
}

// First start → last end can hide a long gap between sessions, so the time
// actually clocked in (and the day's breaks) are reported alongside it.
export function workedLine(s: EodSummary): string | null {
  if (s.workedSeconds == null) return null;
  const n = s.sessionCount ?? 1;
  return `Time worked: ${fmtDuration(s.workedSeconds)}${n > 1 ? ` (${n} sessions)` : ""}`;
}
export const AUTO_CLOSED = "End Work wasn't pressed — the day was closed automatically at 6 PM.";

// The Start of Day against the day, in one line (the task list shows the rest),
// plus any planned task an admin deleted, since it isn't in the list.
function planLines(s: EodSummary): string[] {
  const p = s.plan;
  if (!p) return [];
  const lines = [`Start of Day (${eodTime(p.submittedAt)}): ${p.doneCount} of ${p.plannedCount} done`];
  for (const t of p.removed ?? []) lines.push(`- Removed by admin: ${t}`);
  return lines;
}

// Plain text for WhatsApp — no markdown. WhatsApp's own *bold* on the title only;
// then every task of the day with its channel, status and note.
export function buildReport(name: string, s: EodSummary): string {
  const lines: string[] = [];
  lines.push(`*Work Report — ${name}*`);
  lines.push(fmtDay(s.date));
  lines.push("");
  if (s.tasks) {
    const done = s.tasks.filter((t) => t.status === "done").length;
    lines.push(`Today's tasks (${s.tasks.length}) · ${done} done:`);
    if (!s.tasks.length) lines.push("- No tasks logged today");
    s.tasks.forEach((t, i) => {
      const meta = eodTaskMeta(t);
      lines.push(`${i + 1}. ${t.title}${meta ? ` (${meta})` : ""} — ${eodStatusLabel(t)}`);
      for (const l of (t.note ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) lines.push(`   ${l}`);
    });
  } else {
    lines.push(`Completed today: ${s.completedCount} ${s.completedCount === 1 ? "task" : "tasks"}`);
    for (const g of s.groups) lines.push(`- Completed ${g.n} ${g.label}`);
  }
  const plan = planLines(s);
  if (plan.length) {
    lines.push("");
    lines.push(...plan);
  }
  lines.push("");
  lines.push(`Working hours: ${eodTime(s.startedAt)} - ${eodTime(s.endedAt)}`);
  const worked = workedLine(s);
  if (worked) lines.push(worked);
  if (s.breakSeconds != null) lines.push(`Breaks: ${fmtDuration(s.breakSeconds)}`);
  if (s.autoClosed) lines.push(AUTO_CLOSED);
  return lines.join("\n");
}
