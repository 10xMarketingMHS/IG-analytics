import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { fmtDuration, type EodSummary } from "@/lib/use-eod";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDay(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// "Completed today" and "due today" are different sets of tasks, so the due-today
// figure gets its own line rather than being the bottom half of a fraction.
function dueTodayLine(s: EodSummary): string | null {
  if (!s.dueToday) return null;
  return `Due today: ${s.dueTodayDone ?? 0} of ${s.dueToday} done`;
}

// First start → last end can hide a long gap between sessions, so the time
// actually clocked in (and the day's breaks) are reported alongside it.
function workedLine(s: EodSummary): string | null {
  if (s.workedSeconds == null) return null;
  const n = s.sessionCount ?? 1;
  return `Time worked: ${fmtDuration(s.workedSeconds)}${n > 1 ? ` (${n} sessions)` : ""}`;
}
const AUTO_CLOSED = "End Work wasn't pressed — the day was closed automatically at 6 PM.";

// The morning plan against the day: planned vs done, then what wasn't done and
// what was worked on outside the plan.
function planLines(s: EodSummary): string[] {
  const p = s.plan;
  if (!p) return [];
  const lines = [`Plan (sent ${fmtTime(p.submittedAt)}): ${p.doneCount} of ${p.plannedCount} done`];
  for (const t of p.notDone) lines.push(`- Not done: ${t}`);
  for (const t of p.removed ?? []) lines.push(`- Removed by admin: ${t}`);
  if (p.unplanned.length) {
    lines.push(`Outside the plan: ${p.unplanned.length}`);
    for (const t of p.unplanned) lines.push(`- ${t}`);
  }
  return lines;
}

// Plain text for WhatsApp — no markdown. WhatsApp's own *bold* on the title only;
// everything else plain lines + simple bullets.
export function buildReport(name: string, s: EodSummary): string {
  const lines: string[] = [];
  lines.push(`*Work Report — ${name}*`);
  lines.push(fmtDay(s.date));
  lines.push("");
  lines.push(`Completed today: ${s.completedCount} ${s.completedCount === 1 ? "task" : "tasks"}`);
  if (s.groups.length) {
    for (const g of s.groups) lines.push(`- Completed ${g.n} ${g.label}`);
  } else {
    lines.push("- No completed tasks logged");
  }
  const due = dueTodayLine(s);
  if (due) lines.push(due);
  const plan = planLines(s);
  if (plan.length) {
    lines.push("");
    lines.push(...plan);
  }
  lines.push("");
  lines.push(`Working hours: ${fmtTime(s.startedAt)} - ${fmtTime(s.endedAt)}`);
  const worked = workedLine(s);
  if (worked) lines.push(worked);
  if (s.breakSeconds != null) lines.push(`Breaks: ${fmtDuration(s.breakSeconds)}`);
  if (s.autoClosed) lines.push(AUTO_CLOSED);
  return lines.join("\n");
}

export function EodSummaryCard({ name, summary, onClose }: { name: string; summary: EodSummary; onClose: () => void }) {
  const report = buildReport(name, summary);
  const worked = workedLine(summary);
  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      toast.success("Report copied — paste it into WhatsApp.");
    } catch {
      toast.error("Couldn't copy automatically — select the text and copy it.");
    }
  }
  return (
    <Modal onClose={onClose} title="Work Day Summary">
      <div className="eod-summary">
        <div className="eod-sum-top">
          <div>
            <div className="eod-sum-hours">🕘 {fmtTime(summary.startedAt)} – {fmtTime(summary.endedAt)}</div>
            {(worked || summary.breakSeconds != null) && (
              <div className="eod-sum-worked">
                {worked}
                {worked && summary.breakSeconds != null && " · "}
                {summary.breakSeconds != null && `Breaks: ${fmtDuration(summary.breakSeconds)}`}
              </div>
            )}
          </div>
          <div className="eod-sum-ratio">
            <b>{summary.completedCount}</b> {summary.completedCount === 1 ? "task" : "tasks"} completed today
            {dueTodayLine(summary) && <div className="eod-sum-due">{dueTodayLine(summary)}</div>}
          </div>
        </div>
        {summary.autoClosed && <div className="eod-sum-auto">⚠️ {AUTO_CLOSED}</div>}
        {summary.plan && (
          <div className="eod-sum-plan">
            <div className="eod-sum-plan-head">
              📝 Plan: <b>{summary.plan.doneCount} of {summary.plan.plannedCount}</b> done
              <span className="hint" style={{ margin: "0 0 0 8px" }}>sent {fmtTime(summary.plan.submittedAt)}</span>
            </div>
            {summary.plan.notDone.length > 0 && <div>Not done: {summary.plan.notDone.join(", ")}</div>}
            {(summary.plan.removed?.length ?? 0) > 0 && <div>Removed by admin: {summary.plan.removed!.join(", ")}</div>}
            {summary.plan.unplanned.length > 0 && <div>Outside the plan: {summary.plan.unplanned.join(", ")}</div>}
          </div>
        )}
        <div className="eod-sum-groups">
          {summary.groups.length === 0 ? (
            <div className="hint" style={{ padding: "6px 0" }}>No completed tasks in this session.</div>
          ) : summary.groups.map((g) => (
            <div className="eod-sum-row" key={g.label}>
              <span className="eod-sum-n">{g.n}</span>
              <span>Completed <b>{g.label}</b></span>
            </div>
          ))}
        </div>
        <div className="eod-sum-reportlabel">Report preview (what gets copied)</div>
        <pre className="eod-sum-report">{report}</pre>
      </div>
      <div className="formfoot">
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={copy}>📋 Copy Report</button>
      </div>
    </Modal>
  );
}
