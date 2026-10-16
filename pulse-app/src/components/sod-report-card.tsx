import { toast } from "sonner";
import { Modal } from "@/components/modal";
import type { SodPlan } from "@/lib/use-eod";
import { SOD_GROUP_LABEL, SOD_GROUPS, buildSodReport, plannedTasks, sodTaskLine, sodTime } from "@/lib/sod-report";

// A saved Start of Day: the tasks by group (unticked ones included, so the
// admin sees what was left out), and the text that was copied for WhatsApp.
// Opened by the admin from the Work Day page.
export function SodReportView({ name, plan, onClose, closeLabel = "Close" }: {
  name: string;
  plan: SodPlan;
  onClose: () => void;
  closeLabel?: string;
}) {
  const report = buildSodReport(name, plan);
  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      toast.success("SOD copied — paste it into WhatsApp.");
    } catch {
      toast.error("Couldn't copy automatically — select the text and copy it.");
    }
  }
  return (
    <>
      <div className="plan-sent">
        📋 Copied at {sodTime(plan.submittedAt)} · {plannedTasks(plan).length} {plannedTasks(plan).length === 1 ? "task" : "tasks"}
        {plan.startedAt && <> · started work {sodTime(plan.startedAt)}</>}
      </div>
      {[...SOD_GROUPS, "skipped" as const].map((g) => {
        const tasks = plan.tasks.filter((t) => t.group === g);
        if (!tasks.length) return null;
        return (
          <div key={g}>
            <div className="plan-sec">{SOD_GROUP_LABEL[g]}</div>
            {tasks.map((t) => <div key={t.id} className="plan-row"><span className="plan-title">{sodTaskLine(t)}</span></div>)}
          </div>
        );
      })}
      {plan.note && <div className="plan-note">Note: {plan.note}</div>}
      <div className="eod-sum-reportlabel">Report preview (what gets copied)</div>
      <pre className="eod-sum-report">{report}</pre>
      <div className="formfoot">
        <button className="btn" onClick={copy}>📋 Copy SOD</button>
        <button className="btn btn-primary" onClick={onClose}>{closeLabel}</button>
      </div>
    </>
  );
}

export function SodReportModal({ name, plan, onClose }: { name: string; plan: SodPlan; onClose: () => void }) {
  return (
    <Modal title={`Start of Day — ${name}`} onClose={onClose} wide>
      <SodReportView name={name} plan={plan} onClose={onClose} />
    </Modal>
  );
}
