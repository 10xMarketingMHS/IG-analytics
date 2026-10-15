import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { SodReportView } from "@/components/sod-report-card";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useEodState } from "@/lib/eod-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useContentFormats } from "@/lib/use-content-formats";
import { notifyTasksChanged } from "@/lib/task-events";
import { noteTaskSeen } from "@/lib/use-task-notify";
import type { SodTask } from "@/lib/use-eod";

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Start of Day — "Plan your day". Opens by itself after the first Start Work of
// the day: tasks already on the employee's plate are listed, they add the rest
// of today's work (each one becomes a To Do task on the board), may pick up open
// tasks due later, and send the plan. Task work stays locked until they do.
// Once sent, the same window shows the plan and its copyable report.
export function PlanDayModal() {
  const { sod, planOpen, setPlanOpen, refreshSod, sendPlan } = useEodState();
  const { user } = useAuth();
  const { active } = useWorkspaces();
  const { contentFormats } = useContentFormats();
  const formats = (contentFormats ?? []).filter((f) => f.active && f.category);

  const [title, setTitle] = useState("");
  const [formatId, setFormatId] = useState("");
  const [due, setDue] = useState(todayYmd());
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [extra, setExtra] = useState<Set<string>>(new Set());
  // Tasks already on their plate that they unticked — not working on them today.
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  if (!planOpen || !sod) return null;
  const firstName = (user?.name || user?.email || "You").split(" ")[0].split("@")[0];
  const close = () => setPlanOpen(false);

  if (sod.plan) {
    return (
      <Modal title="Today's plan" onClose={close} wide>
        <SodReportView name={firstName} plan={sod.plan} onClose={close} closeLabel="Done" />
      </Modal>
    );
  }
  if (!sod.required) return null;

  const group = (g: SodTask["group"]) => sod.candidates.filter((t) => t.group === g);
  const onPlate = group("today");
  const added = group("added");
  const later = group("later");
  const count = onPlate.filter((t) => !skip.has(t.id)).length + added.length + later.filter((t) => extra.has(t.id)).length;

  async function addTask(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setAddError("Enter what the task is.");
    const f = formats.find((x) => x.id === formatId);
    if (!f) return setAddError("Pick a content type.");
    setAdding(true);
    setAddError(null);
    try {
      const made = await api<{ task: { id: string } }>("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(), taskType: f.category, channelId: active?.id ?? null,
          contentFormatId: f.id, editorId: user?.editorId ?? null, dueDate: due || null,
        }),
      });
      // Their own new task — no "New task" pop-up about it.
      if (user) noteTaskSeen(user.id, made.task.id);
      setTitle("");
      await refreshSod();
      notifyTasksChanged();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Couldn't add that task.");
    } finally {
      setAdding(false);
    }
  }

  async function removeTask(t: SodTask) {
    try {
      await api(`/tasks/${t.id}`, { method: "DELETE" });
      await refreshSod();
      notifyTasksChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't remove that task.");
    }
  }

  async function send() {
    setSending(true);
    try {
      await sendPlan(note, [...extra], [...skip]);
      toast.success("Plan sent — your tasks are unlocked.");
      notifyTasksChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't send your plan.");
    } finally {
      setSending(false);
    }
  }

  const startedAt = sod.startedAt
    ? new Date(sod.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const tagClass = (t: SodTask) => "plan-tag" + (/late|sent back/.test(t.reason) ? " warn" : "");

  return (
    <Modal title="Plan your day" onClose={close} wide>
      <div className="plan-intro">
        {dateLabel}{startedAt ? ` · started ${startedAt}` : ""}. Add everything you'll work on today, then send your plan.
        You do this once each morning; your tasks unlock when it's sent.
      </div>

      <div className="plan-sec">Already on your plate — untick any you're not working on today</div>
      {onPlate.length === 0 ? (
        <div className="plan-empty">Nothing assigned for today.</div>
      ) : onPlate.map((t) => (
        <label key={t.id} className={"plan-row plan-pick" + (skip.has(t.id) ? " plan-off" : "")}>
          <input
            type="checkbox" checked={!skip.has(t.id)}
            onChange={(e) => setSkip((s) => { const n = new Set(s); if (e.target.checked) n.delete(t.id); else n.add(t.id); return n; })}
          />
          <span className="plan-title">{t.title}</span>
          {t.format && <span className="plan-fmt">{t.format}</span>}
          {t.reason && <span className={tagClass(t)}>{t.reason}</span>}
        </label>
      ))}
      {skip.size > 0 && (
        <div className="plan-empty">{skip.size} left out — they stay on your board and show in your plan as "not working on today".</div>
      )}

      <div className="plan-sec">Added by you</div>
      {added.map((t) => (
        <div key={t.id} className="plan-row">
          <span className="plan-title">{t.title}</span>
          {t.format && <span className="plan-fmt">{t.format}</span>}
          {t.reason && <span className="plan-tag">{t.reason}</span>}
          <button type="button" className="task-x" title="Remove this task" onClick={() => removeTask(t)}>✕</button>
        </div>
      ))}
      <form className="plan-add" onSubmit={addTask}>
        <input
          className="t" placeholder="Reply to comments on today's post" aria-label="New task"
          value={title} onChange={(e) => { setTitle(e.target.value); setAddError(null); }}
        />
        <select className="t" aria-label="Content type" value={formatId} onChange={(e) => { setFormatId(e.target.value); setAddError(null); }}>
          <option value="">Content type…</option>
          {formats.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
        <input className="t" type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="submit" className="btn" disabled={adding}>{adding ? "Adding…" : "＋ Add"}</button>
      </form>
      {addError && <div className="plan-err" role="alert">{addError}</div>}

      {later.length > 0 && (
        <>
          <div className="plan-sec">Also on your list (due later) — tick any you'll work on today</div>
          {later.map((t) => (
            <label key={t.id} className="plan-row plan-pick">
              <input
                type="checkbox" checked={extra.has(t.id)}
                onChange={(e) => setExtra((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })}
              />
              <span className="plan-title">{t.title}</span>
              {t.format && <span className="plan-fmt">{t.format}</span>}
              {t.reason && <span className="plan-tag">{t.reason}</span>}
            </label>
          ))}
        </>
      )}

      <div className="plan-sec">Note for today (optional)</div>
      <textarea
        className="t plan-notebox" rows={2} placeholder="Finishing the carousel before lunch"
        value={note} onChange={(e) => setNote(e.target.value)}
      />

      <div className="formfoot plan-foot">
        <span className="hint" style={{ margin: 0, flex: 1 }}>{count} {count === 1 ? "task" : "tasks"} in today's plan</span>
        <button className="btn" onClick={close}>Later</button>
        <button className="btn btn-primary" disabled={sending} onClick={send}>{sending ? "Sending…" : "Send my plan"}</button>
      </div>
    </Modal>
  );
}
