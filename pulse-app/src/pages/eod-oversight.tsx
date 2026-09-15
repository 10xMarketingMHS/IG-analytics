import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { EodSummaryCard } from "@/components/eod-summary-card";
import type { EodSummary } from "@/lib/use-eod";

// Admin EOD oversight — one row per (non-admin) editor, their Start/End status
// for a chosen date, with a way to open any editor's full summary for that day.
type TeamRow = {
  id: string;
  name: string | null;
  status: "not_started" | "active" | "completed";
  startedAt: string | null;
  endedAt: string | null;
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
}
const STATUS: Record<TeamRow["status"], { label: string; cls: string }> = {
  not_started: { label: "Not started", cls: "ns" },
  active: { label: "Active", cls: "ac" },
  completed: { label: "Completed", cls: "cp" },
};

export function EodOversightSection() {
  const [date, setDate] = useState(todayStr());
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [open, setOpen] = useState<{ name: string; summary: EodSummary } | null>(null);
  const [loadingSum, setLoadingSum] = useState(false);

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
    <div>
      <div className="goalt-owner" style={{ marginBottom: 16 }}>
        <span className="goalt-owner-l">Date</span>
        <input className="t" type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 180 }} />
        <span className="goalt-owner-hint">Each editor's Start / End EOD status for the day</span>
      </div>

      {rows === null ? (
        <div className="card pad hint">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card pad home-empty">No editors to show.</div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr><th>Editor</th><th>Status</th><th>Start</th><th>End</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b style={{ fontWeight: 650 }}>{r.name ?? "—"}</b></td>
                  <td>
                    <span className={"eod-st " + STATUS[r.status].cls}>
                      {r.status === "active" && r.startedAt ? `Active since ${fmtTime(r.startedAt)}` : STATUS[r.status].label}
                    </span>
                  </td>
                  <td>{fmtTime(r.startedAt)}</td>
                  <td>{fmtTime(r.endedAt)}</td>
                  <td>
                    <button className="btn" disabled={r.status === "not_started" || loadingSum} onClick={() => openSummary(r)}>
                      View summary
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <EodSummaryCard name={open.name} summary={open.summary} onClose={() => setOpen(null)} />}
    </div>
  );
}
