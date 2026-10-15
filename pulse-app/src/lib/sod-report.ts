import type { SodPlan, SodTask } from "@/lib/use-eod";

// The three parts of a morning plan, in reading order.
export const SOD_GROUPS: SodTask["group"][] = ["today", "added", "later"];
export const SOD_GROUP_LABEL: Record<SodTask["group"], string> = {
  today: "Already on my plate",
  added: "Added by me",
  later: "Also picking up",
  skipped: "Not working on today",
};
// Tasks that count as today's plan (left-out ones are listed, not counted).
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

// Plain text for WhatsApp, same style as the End of Day report.
export function buildSodReport(name: string, plan: SodPlan): string {
  const lines: string[] = [];
  lines.push(`*Start of Day — ${name}*`);
  lines.push(`${fmtDay(plan.date)}${plan.startedAt ? ` · started ${fmtTime(plan.startedAt)}` : ""}`);
  lines.push("");
  const n = plannedTasks(plan).length;
  lines.push(`Today's plan (${n} ${n === 1 ? "task" : "tasks"}):`);
  if (!n) lines.push("- Nothing planned");
  for (const g of SOD_GROUPS) {
    const tasks = plan.tasks.filter((t) => t.group === g);
    if (!tasks.length) continue;
    lines.push(`${SOD_GROUP_LABEL[g]}:`);
    for (const t of tasks) lines.push(`- ${sodTaskLine(t)}`);
  }
  const skipped = plan.tasks.filter((t) => t.group === "skipped");
  if (skipped.length) {
    lines.push("");
    lines.push(`${SOD_GROUP_LABEL.skipped} (${skipped.length}):`);
    for (const t of skipped) lines.push(`- ${sodTaskLine(t)}`);
  }
  if (plan.note) {
    lines.push("");
    lines.push(`Note: ${plan.note}`);
  }
  return lines.join("\n");
}

export { fmtTime as sodTime };
