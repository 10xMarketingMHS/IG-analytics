import type { SodPlan, SodTask } from "@/lib/use-eod";

// The three parts of a Start of Day, in reading order.
export const SOD_GROUPS: SodTask["group"][] = ["added", "today", "later"];
export const SOD_GROUP_LABEL: Record<SodTask["group"], string> = {
  added: "Added today",
  today: "On my plate",
  later: "Also picking up",
  skipped: "Not working on today",
};
// Tasks that count as today's SOD (unticked ones are listed, not counted).
export const plannedTasks = (plan: SodPlan) => plan.tasks.filter((t) => t.group !== "skipped");

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDay(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// "Reel cover (Thumbnail) — due today"
export function sodTaskLine(t: SodTask): string {
  return `${t.title}${t.format ? ` (${t.format})` : ""}${t.reason ? ` — ${t.reason}` : ""}`;
}

// Plain text for WhatsApp, same style as the End of Day report: today's ticked
// tasks as one list (unticked ones stay out of the message).
export function buildSodReport(name: string, plan: SodPlan): string {
  const lines: string[] = [];
  lines.push(`*Start of Day — ${name}*`);
  lines.push(`${fmtDay(plan.date)}${plan.startedAt ? ` · started ${fmtTime(plan.startedAt)}` : ""}`);
  lines.push("");
  const tasks = SOD_GROUPS.flatMap((g) => plan.tasks.filter((t) => t.group === g));
  lines.push(`Today's tasks (${tasks.length}):`);
  if (!tasks.length) lines.push("- Nothing yet");
  for (const t of tasks) lines.push(`- ${t.title}${t.format ? ` (${t.format})` : ""}`);
  if (plan.note) {
    lines.push("");
    lines.push(`Note: ${plan.note}`);
  }
  return lines.join("\n");
}

export { fmtTime as sodTime };
