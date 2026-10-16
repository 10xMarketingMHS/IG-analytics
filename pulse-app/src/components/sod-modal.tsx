import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useEodState } from "@/lib/eod-context";
import { buildSodReport, plannedTasks, sodTaskMeta, sodTime } from "@/lib/sod-report";
import type { SodPlan, SodTask, SodToday } from "@/lib/use-eod";

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The starting ticks: what was ticked at the last copy (plus anything new that's
// clearly for today), or — before the first copy — the server's suggestion.
function defaultPicks(sod: SodToday): Set<string> {
  if (!sod.plan) return new Set(sod.candidates.filter((t) => t.suggested).map((t) => t.id));
  const inRecord = new Set(sod.plan.tasks.map((t) => t.id));
  const kept = new Set(plannedTasks(sod.plan).map((t) => t.id));
  return new Set(sod.candidates.filter((t) => kept.has(t.id) || (!inRecord.has(t.id) && t.suggested)).map((t) => t.id));
}

const SECTIONS: { group: SodTask["group"]; label: string }[] = [
  { group: "added", label: "Added today" },
  { group: "today", label: "On your plate" },
  { group: "later", label: "Due later" },
];

// Start of Day — opened from My Day after Start Work. The employee's open tasks,
// ticked for today or not, and the report to copy for WhatsApp, the morning
// twin of the End of Day report. Copying also saves the list as today's SOD
// (the admin sees it; End of Day compares against it). Nothing is locked.
export function SodModal() {
  const { sod, planOpen, setPlanOpen, saveSod } = useEodState();
  const { user } = useAuth();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  if (!planOpen || !sod) return null;
  const close = () => { setPlanOpen(false); setPicked(null); };
  const chosen = picked ?? defaultPicks(sod);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id); else next.delete(id);
    setPicked(next);
  };

  const firstName = (user?.name || user?.email || "You").split(" ")[0].split("@")[0];
  const preview: SodPlan = {
    id: "", date: todayYmd(), submittedAt: new Date().toISOString(), note: null, editorName: null, startedAt: sod.startedAt,
    tasks: sod.candidates
      .filter((t) => chosen.has(t.id) || t.group !== "later")
      .map((t) => (chosen.has(t.id) ? t : { ...t, group: "skipped" as const })),
  };
  const report = buildSodReport(firstName, preview);
  const count = sod.candidates.filter((t) => chosen.has(t.id)).length;

  async function copy() {
    let copied = true;
    try { await navigator.clipboard.writeText(report); } catch { copied = false; }
    setSaving(true);
    try {
      await saveSod([...chosen]);
      if (copied) toast.success("SOD copied — paste it into WhatsApp.");
      else toast.error("Saved, but it couldn't be copied automatically — select the report text and copy it.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : copied ? "Copied, but it couldn't be saved — try again." : "Couldn't save your Start of Day.");
    } finally {
      setSaving(false);
    }
  }

  const startedAt = sod.startedAt ? sodTime(sod.startedAt) : null;
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const tagClass = (t: SodTask) => "plan-tag" + (/late|sent back/.test(t.reason) ? " warn" : "");

  return (
    <Modal title="Start of Day" onClose={close} wide>
      <div className="plan-intro">
        {dateLabel}{startedAt ? ` · started ${startedAt}` : ""}. Tick the tasks you're working on today, then copy your SOD for WhatsApp.
        New task? <Link to="/tasks" onClick={close}>Add it on the Task Board</Link> first.
      </div>

      {sod.candidates.length === 0 ? (
        <div className="plan-empty" style={{ margin: "12px 0" }}>
          No open tasks yet. <Link to="/tasks" onClick={close}>Add today's tasks on the Task Board</Link>, then come back here.
        </div>
      ) : SECTIONS.map(({ group, label }) => {
        const tasks = sod.candidates.filter((t) => t.group === group);
        if (!tasks.length) return null;
        return (
          <div key={group}>
            <div className="plan-sec">{label}</div>
            {tasks.map((t) => (
              <label key={t.id} className={"plan-row plan-pick" + (chosen.has(t.id) ? "" : " plan-off")}>
                <input type="checkbox" checked={chosen.has(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} />
                <span className="plan-title">{t.title}</span>
                {sodTaskMeta(t) && <span className="plan-fmt">{sodTaskMeta(t)}</span>}
                {t.reason && <span className={tagClass(t)}>{t.reason}</span>}
              </label>
            ))}
          </div>
        );
      })}

      <div className="eod-sum-reportlabel">Report preview (what gets copied)</div>
      <pre className="eod-sum-report">{report}</pre>

      <div className="formfoot plan-foot">
        <span className="hint" style={{ margin: 0, flex: 1 }}>
          {count} {count === 1 ? "task" : "tasks"} in today's SOD{sod.plan ? ` · last copied ${sodTime(sod.plan.submittedAt)}` : ""}
        </span>
        <button className="btn" onClick={close}>Close</button>
        <button className="btn btn-primary" disabled={saving} onClick={copy}>{saving ? "Saving…" : "📋 Copy SOD"}</button>
      </div>
    </Modal>
  );
}
