import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useEodState } from "@/lib/eod-context";
import { buildReport, eodStatusLabel, eodTaskMeta, eodTime } from "@/lib/eod-report";
import { fmtDuration, type EodSummary } from "@/lib/use-eod";

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// End of Day — what End Work opens: the day's tasks (status, channel) with a
// box for what was done on each, and the report that will be copied. Notes
// can be saved along the way; "End Work and copy report" saves them, ends the
// day, copies the report and leaves the day's summary on screen.
export function EodWindow() {
  const { eodOpen, closeEod, session, saveNotes, end } = useEodState();
  const { user } = useAuth();
  const [day, setDay] = useState<EodSummary | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"save" | "end" | null>(null);
  // The task whose note box is open (one at a time).
  const [openId, setOpenId] = useState<string | null>(null);

  const sessionId = session?.id ?? null;
  // Bumped by "Try again" to load the day once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!eodOpen || !sessionId) return;
    let cancel = false;
    api<{ summary: EodSummary }>(`/eod/summary?date=${todayYmd()}`)
      .then((d) => {
        if (cancel) return;
        setDay(d.summary);
        setNotes(Object.fromEntries((d.summary.tasks ?? []).map((t) => [t.id, t.note ?? ""])));
        setFailed(false);
      })
      .catch(() => { if (!cancel) setFailed(true); });
    return () => { cancel = true; };
  }, [eodOpen, sessionId, attempt]);

  if (!eodOpen) return null;
  const close = (ended: boolean) => { closeEod(ended); setDay(null); setNotes({}); setOpenId(null); };
  const firstName = (user?.name || user?.email || "You").split(" ")[0].split("@")[0];
  const tasks = day?.tasks ?? [];
  const payload = () => tasks.map((t) => ({ taskId: t.id, note: notes[t.id] ?? "" }));

  async function save() {
    setBusy("save");
    try {
      setDay(await saveNotes(payload()));
      toast.success("Notes saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save your notes.");
    } finally {
      setBusy(null);
    }
  }

  async function endDay() {
    setBusy("end");
    try {
      await saveNotes(payload());
      const summary = await end();
      let copied = false;
      if (summary) {
        try { await navigator.clipboard.writeText(buildReport(firstName, summary)); copied = true; } catch { /* copy from the summary */ }
      }
      toast.success(copied ? "Day ended — report copied. Paste it into WhatsApp." : "Day ended. Copy the report from the summary.");
      close(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't end your work day.");
    } finally {
      setBusy(null);
    }
  }

  const preview = day ? buildReport(firstName, {
    ...day,
    endedAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({ ...t, note: notes[t.id]?.trim() || null })),
  }) : "";
  const sessions = day?.sessionCount ?? 1;

  return (
    <Modal title="End of Day" onClose={() => close(false)} wide>
      <div className="plan-intro">
        {day ? (
          <>
            Started {eodTime(day.startedAt)}
            {day.workedSeconds != null ? ` · ${fmtDuration(day.workedSeconds)} worked${sessions > 1 ? ` (${sessions} sessions)` : ""}` : ""}
            {day.breakSeconds != null ? ` · breaks ${fmtDuration(day.breakSeconds)}` : ""}.{" "}
          </>
        ) : null}
        Click a task to add a line on what you did. Tasks without a note still appear in the report.
      </div>

      {failed ? (
        <div className="plan-empty" style={{ margin: "12px 0", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          Couldn't load today's tasks. Check your connection, then try again.
          <button type="button" className="btn btn-sm" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>Try again</button>
        </div>
      ) : !day ? (
        <div className="plan-empty" style={{ margin: "12px 0" }}>Loading today's tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="plan-empty" style={{ margin: "12px 0" }}>No tasks today yet.</div>
      ) : (
        <div className="eod-list">
          {tasks.map((t) => {
            const open = openId === t.id;
            const note = (notes[t.id] ?? "").trim();
            return (
              <div className={"eod-item" + (open ? " open" : "")} key={t.id}>
                <button
                  type="button" className="eod-item-head" aria-expanded={open}
                  onClick={() => setOpenId(open ? null : t.id)}
                >
                  <span className="eod-chev" aria-hidden="true">▸</span>
                  <span className="eod-item-main">
                    <span className="eod-item-title">{t.title}</span>
                    <span className={"eod-item-sub" + (note ? " has-note" : "")}>
                      {note ? `📝 ${note.split(/\r?\n/)[0]}` : "Add a note…"}
                    </span>
                  </span>
                  {eodTaskMeta(t) && <span className="eod-task-meta">{eodTaskMeta(t)}</span>}
                  <span className={"eod-task-st " + t.status}>{eodStatusLabel(t)}</span>
                </button>
                {open && (
                  <div className="eod-item-body">
                    <textarea
                      className="t eod-task-input" rows={3} maxLength={2000} autoFocus
                      placeholder="What did you do on this today?"
                      aria-label={`What you did on ${t.title}`}
                      value={notes[t.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [t.id]: e.target.value }))}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {day && (
        <>
          <div className="eod-sum-reportlabel">Report preview (what gets copied)</div>
          <pre className="eod-sum-report full">{preview}</pre>
        </>
      )}

      <div className="formfoot plan-foot">
        <span className="hint" style={{ margin: 0, flex: 1 }}>Notes are optional.</span>
        <button className="btn" onClick={() => close(false)} disabled={busy !== null}>Close</button>
        <button className="btn" onClick={save} disabled={!day || busy !== null}>{busy === "save" ? "Saving…" : "Save notes"}</button>
        <button className="btn btn-primary" onClick={endDay} disabled={!day || busy !== null}>
          {busy === "end" ? "Ending…" : "⏹ End Work and copy report"}
        </button>
      </div>
    </Modal>
  );
}
