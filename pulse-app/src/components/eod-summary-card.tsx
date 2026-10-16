import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { fmtDuration, type EodSummary } from "@/lib/use-eod";
import { AUTO_CLOSED, buildReport, dueTodayLine, eodStatusLabel, eodTaskMeta, eodTime, workedLine } from "@/lib/eod-report";

// The day's summary after End Work (and for the admin, from Work Day): hours,
// the Start of Day line, every task of the day with its status and note, and
// the WhatsApp report.
export function EodSummaryCard({ name, summary, onClose }: { name: string; summary: EodSummary; onClose: () => void }) {
  const report = buildReport(name, summary);
  const worked = workedLine(summary);
  const tasks = summary.tasks ?? [];
  const doneCount = tasks.filter((t) => t.status === "done").length;
  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      toast.success("Report copied — paste it into WhatsApp.");
    } catch {
      toast.error("Couldn't copy automatically — select the text and copy it.");
    }
  }
  return (
    <Modal onClose={onClose} title="Work Day Summary" wide>
      <div className="eod-summary">
        <div className="eod-sum-top">
          <div>
            <div className="eod-sum-hours">🕘 {eodTime(summary.startedAt)} – {eodTime(summary.endedAt)}</div>
            {(worked || summary.breakSeconds != null) && (
              <div className="eod-sum-worked">
                {worked}
                {worked && summary.breakSeconds != null && " · "}
                {summary.breakSeconds != null && `Breaks: ${fmtDuration(summary.breakSeconds)}`}
              </div>
            )}
          </div>
          <div className="eod-sum-ratio">
            <b>{doneCount}</b> of {tasks.length} {tasks.length === 1 ? "task" : "tasks"} done
            {dueTodayLine(summary) && <div className="eod-sum-due">{dueTodayLine(summary)}</div>}
          </div>
        </div>
        {summary.autoClosed && <div className="eod-sum-auto">⚠️ {AUTO_CLOSED}</div>}
        {summary.plan && (
          <div className="eod-sum-plan">
            <div className="eod-sum-plan-head">
              📋 Start of Day: <b>{summary.plan.doneCount} of {summary.plan.plannedCount}</b> done
              <span className="hint" style={{ margin: "0 0 0 8px" }}>copied {eodTime(summary.plan.submittedAt)}</span>
            </div>
            {(summary.plan.removed?.length ?? 0) > 0 && <div>Removed by admin: {summary.plan.removed!.join(", ")}</div>}
          </div>
        )}
        <div className="eod-tasks">
          {tasks.length === 0 ? (
            <div className="hint" style={{ padding: "6px 0" }}>No tasks logged today.</div>
          ) : tasks.map((t) => (
            <div className="eod-task" key={t.id}>
              <div className="eod-task-head">
                <span className="eod-task-title">{t.title}</span>
                {eodTaskMeta(t) && <span className="eod-task-meta">{eodTaskMeta(t)}</span>}
                <span className={"eod-task-st " + t.status}>{eodStatusLabel(t)}</span>
              </div>
              {t.note && <div className="eod-task-note">{t.note}</div>}
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
