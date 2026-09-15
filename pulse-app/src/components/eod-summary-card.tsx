import { toast } from "sonner";
import { Modal } from "@/components/modal";
import type { EodSummary } from "@/lib/use-eod";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDay(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// Plain text for WhatsApp — no markdown. WhatsApp's own *bold* on the title only;
// everything else plain lines + simple bullets.
export function buildReport(name: string, s: EodSummary): string {
  const lines: string[] = [];
  lines.push(`*EOD Report — ${name}*`);
  lines.push(fmtDay(s.date));
  lines.push("");
  lines.push(`Completed: ${s.completedCount}/${s.dueToday} tasks`);
  if (s.groups.length) {
    for (const g of s.groups) lines.push(`- Completed ${g.n} ${g.label}`);
  } else {
    lines.push("- No completed tasks logged");
  }
  lines.push("");
  lines.push(`Working hours: ${fmtTime(s.startedAt)} - ${fmtTime(s.endedAt)}`);
  return lines.join("\n");
}

export function EodSummaryCard({ name, summary, onClose }: { name: string; summary: EodSummary; onClose: () => void }) {
  const report = buildReport(name, summary);
  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      toast.success("Report copied — paste it into WhatsApp.");
    } catch {
      toast.error("Couldn't copy automatically — select the text and copy it.");
    }
  }
  return (
    <Modal onClose={onClose} title="End of Day Summary">
      <div className="eod-summary">
        <div className="eod-sum-top">
          <div className="eod-sum-hours">🕘 {fmtTime(summary.startedAt)} – {fmtTime(summary.endedAt)}</div>
          <div className="eod-sum-ratio">
            <b>{summary.completedCount}</b><span>/{summary.dueToday}</span> tasks completed today
          </div>
        </div>
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
