import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Modal } from "@/components/modal";
import { EodSummaryCard } from "@/components/eod-summary-card";
import { SodReportModal } from "@/components/sod-report-card";
import { fmtDuration, type EodSummary, type SodPlan } from "@/lib/use-eod";
import "./my-reports.css";

// My reports — a team member's own Start of Day and End of Day reports, today
// and past days, to read again or copy for WhatsApp. A pop-up opened from the
// Home banner (not a page of its own); one window at a time: the list, or the
// report picked from it, whose Close comes back to the list.

type Day = {
  date: string;
  status: "not_started" | "active" | "completed";
  startedAt: string | null;
  endedAt: string | null;
  sessions: number;
  workedSeconds: number;
  autoClosed: boolean;
  planSubmittedAt: string | null;
  planCount: number | null;
};

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");
function dayLabel(date: string): [string, string] {
  const d = new Date(`${date}T00:00:00`);
  const today = new Date();
  const yday = new Date(); yday.setDate(today.getDate() - 1);
  const long = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  if (date === ymd(today)) return ["Today", long];
  if (date === ymd(yday)) return ["Yesterday", long];
  return [d.toLocaleDateString(undefined, { weekday: "long" }), d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })];
}

export function MyReportsModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const name = (user?.name || user?.email || "You").split(" ")[0].split("@")[0];
  const [span, setSpan] = useState(30);
  const [days, setDays] = useState<Day[] | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [openEod, setOpenEod] = useState<EodSummary | null>(null);
  const [openSod, setOpenSod] = useState<SodPlan | null>(null);

  useEffect(() => {
    let cancel = false;
    api<{ days: Day[]; unlinked?: boolean }>(`/eod/my-days?days=${span}`)
      .then((d) => { if (!cancel) { setDays(d.days); setUnlinked(!!d.unlinked); } })
      .catch(() => { if (!cancel) setDays([]); });
    return () => { cancel = true; };
  }, [span]);

  // Today always leads the list, even before Start Work.
  const today = ymd(new Date());
  const rows: Day[] = days === null ? [] : days.some((d) => d.date === today) ? days : [
    { date: today, status: "not_started", startedAt: null, endedAt: null, sessions: 0, workedSeconds: 0, autoClosed: false, planSubmittedAt: null, planCount: null },
    ...days,
  ];

  async function showSod(d: Day) {
    setBusy(d.date + "sod");
    try {
      const r = await api<{ plan: SodPlan | null }>(`/sod?date=${d.date}`);
      if (r.plan) setOpenSod(r.plan); else toast.error("No Start of Day was copied that day.");
    } catch {
      toast.error("Couldn't open that Start of Day.");
    } finally {
      setBusy(null);
    }
  }
  async function showEod(d: Day) {
    setBusy(d.date + "eod");
    try {
      const r = await api<{ summary: EodSummary }>(`/eod/summary?date=${d.date}`);
      setOpenEod(r.summary);
    } catch {
      toast.error("Couldn't open that End of Day.");
    } finally {
      setBusy(null);
    }
  }

  if (openSod) return <SodReportModal name={name} plan={openSod} onClose={() => setOpenSod(null)} />;
  if (openEod) return <EodSummaryCard name={name} summary={openEod} onClose={() => setOpenEod(null)} />;

  return (
    <Modal title="My reports" onClose={onClose}>
      <div className="myr">
        <p className="myr-sub">Your Start of Day and End of Day, today and past days. Open one to read it again or copy it for WhatsApp.</p>
        <div className="myr-list">
          {days === null ? (
            <div className="myr-empty">Loading…</div>
          ) : unlinked ? (
            <div className="myr-empty">Your login isn't linked to the team roster, so there are no work days to show. Ask an admin to link you on Team › Roster.</div>
          ) : (
            rows.map((d) => {
              const [day, sub] = dayLabel(d.date);
              const hours = d.status === "not_started" ? (d.date === today ? "Not started yet" : "No work day")
                : d.status === "active" ? `Working now · since ${fmtTime(d.startedAt)}`
                : `${fmtTime(d.startedAt)} – ${fmtTime(d.endedAt)} · ${fmtDuration(d.workedSeconds)} worked`;
              return (
                <div className="myr-row" key={d.date}>
                  <span className="myr-day"><b>{day}</b><small>{sub}</small></span>
                  <span className="myr-hours">
                    {hours}
                    {d.autoClosed && <em className="myr-warn" title="End Work wasn't pressed, so the day closed on its own at 6 PM">Ended automatically</em>}
                  </span>
                  <span className="myr-acts">
                    <button type="button" className="btn btn-sm" disabled={!d.planSubmittedAt || busy === d.date + "sod"} onClick={() => showSod(d)}
                      title={d.planSubmittedAt ? `Copied at ${fmtTime(d.planSubmittedAt)}` : "No Start of Day was copied this day"}>
                      Start of Day{d.planSubmittedAt ? ` · ${d.planCount ?? 0} ${d.planCount === 1 ? "task" : "tasks"}` : ""}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={d.status === "not_started" || busy === d.date + "eod"} onClick={() => showEod(d)}
                      title={d.status === "not_started" ? "Work wasn't started this day" : d.status === "active" ? "Your End of Day so far" : "Your End of Day report"}>
                      {d.status === "active" ? "End of Day so far" : "End of Day"}
                    </button>
                  </span>
                </div>
              );
            })
          )}
        </div>
        {days !== null && !unlinked && span < 365 && (
          <button type="button" className="btn btn-sm myr-more" onClick={() => setSpan((s) => Math.min(365, s * 3))}>Show older days</button>
        )}
      </div>
    </Modal>
  );
}
