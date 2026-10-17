import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { EodSummaryCard } from "@/components/eod-summary-card";
import { SodReportModal } from "@/components/sod-report-card";
import { fmtDuration, type EodSummary, type SodPlan } from "@/lib/use-eod";

// Admin work-day oversight — one row per (non-admin) editor, their Start/End status
// for a chosen date, with a way to open any editor's full summary for that day.
type TeamRow = {
  id: string;
  name: string | null;
  status: "not_started" | "active" | "completed";
  startedAt: string | null;
  endedAt: string | null;
  sessions?: number;
  workedSeconds?: number;
  autoClosed?: boolean;
  planSubmittedAt?: string | null;
  planCount?: number | null;
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
}
const STATUS: Record<TeamRow["status"], { label: string; cls: string }> = {
  not_started: { label: "Not started", cls: "" },
  active: { label: "Active", cls: "good" },
  completed: { label: "Completed", cls: "ac" },
};

export function EodOversightSection() {
  const [date, setDate] = useState(todayStr());
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [open, setOpen] = useState<{ name: string; summary: EodSummary } | null>(null);
  const [loadingSum, setLoadingSum] = useState(false);
  const [openPlan, setOpenPlan] = useState<{ name: string; plan: SodPlan } | null>(null);

  async function showPlan(r: TeamRow) {
    try {
      const d = await api<{ plan: SodPlan | null }>(`/sod?editorId=${r.id}&date=${date}`);
      if (d.plan) setOpenPlan({ name: (r.name ?? "Editor").split(" ")[0], plan: d.plan });
    } catch {
      toast.error("Could not load that Start of Day.");
    }
  }

  useEffect(() => {
    let cancel = false;
    setRows(null);
    api<{ editors: TeamRow[] }>(`/eod/team?date=${date}`)
      .then((d) => { if (!cancel) setRows(d.editors); })
      .catch(() => { if (!cancel) setRows([]); });
    return () => { cancel = true; };
  }, [date]);

  async function openSummary(r: TeamRow) {
    setLoadingSum(true);
    try {
      const d = await api<{ summary: EodSummary }>(`/eod/summary?editorId=${r.id}&date=${date}`);
      setOpen({ name: r.name ?? "Editor", summary: d.summary });
    } catch {
      toast.error("Could not load that summary.");
    } finally {
      setLoadingSum(false);
    }
  }

  return (
    <>
      <section className="st-card">
        <div className="st-row" style={{ borderTop: 0 }}>
          <span className="st-label">
            <b>Date</b>
            <small>Each person's Start Work and End Work for the day. A day nobody ended is closed automatically at 6 PM and marked.</small>
          </span>
          <input className="st-in" type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
        </div>
        {rows === null ? (
          <div className="st-empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="st-empty">No editors to show.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="st-wd">
              <thead>
                <tr><th>Editor</th><th>Status</th><th>Start</th><th>End</th><th>Worked</th><th>Start of Day</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><b style={{ fontWeight: 650 }}>{r.name ?? "—"}</b></td>
                    <td>
                      <span
                        className={"st-chip " + (r.autoClosed ? "warn" : STATUS[r.status].cls)}
                        title={r.autoClosed ? "End Work wasn't pressed — closed automatically at 6 PM" : undefined}
                      >
                        {r.status === "active" && r.startedAt ? `Active since ${fmtTime(r.startedAt)}`
                          : r.autoClosed ? "Ended automatically" : STATUS[r.status].label}
                      </span>
                    </td>
                    <td>{fmtTime(r.startedAt)}</td>
                    <td>{fmtTime(r.endedAt)}</td>
                    <td>{r.status === "not_started" || r.workedSeconds == null ? "—" : `${fmtDuration(r.workedSeconds)}${(r.sessions ?? 1) > 1 ? ` · ${r.sessions} sessions` : ""}`}</td>
                    <td>
                      {r.planSubmittedAt ? (
                        <button type="button" className="st-link" onClick={() => showPlan(r)} title="View the Start of Day">
                          {fmtTime(r.planSubmittedAt)} · {r.planCount ?? 0} {r.planCount === 1 ? "task" : "tasks"}
                        </button>
                      ) : r.status === "active" ? (
                        <span className="st-chip warn">Not copied yet</span>
                      ) : "—"}
                    </td>
                    <td className="num">
                      <button type="button" className="st-btn sm" disabled={r.status === "not_started" || loadingSum} onClick={() => openSummary(r)}>
                        View summary
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open && <EodSummaryCard name={open.name} summary={open.summary} onClose={() => setOpen(null)} />}
      {openPlan && <SodReportModal name={openPlan.name} plan={openPlan.plan} onClose={() => setOpenPlan(null)} />}
    </>
  );
}
