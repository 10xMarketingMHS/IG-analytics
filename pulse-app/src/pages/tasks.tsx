import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import { toast } from "sonner";
import type { Task, TaskStatus, TaskPriority, Editor, Subtask, TaskComment } from "@/lib/types";

function relTime(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];
const PRI_LABEL: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High" };

function today() {
  // Local calendar date as YYYY-MM-DD (Date.now avoided elsewhere but fine here).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Assignee({ name, image }: { name: string | null; image: string | null }) {
  if (!name) return <span className="task-unassigned">Unassigned</span>;
  return (
    <span className="task-assignee">
      {image ? (
        <img className="task-ava" src={image} alt={name} />
      ) : (
        <span className="task-ava init">{name.charAt(0).toUpperCase()}</span>
      )}
      {name}
    </span>
  );
}

export function TasksPage() {
  const { tasks, refetch } = useTasks();
  const { editors } = useEditors();
  const [filterEditor, setFilterEditor] = useState("");
  const [view, setView] = useState<"board" | "calendar">("board");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const openTask = (t: Task) => { setEditing(t); setModalOpen(true); };

  const filtered = useMemo(
    () => (tasks ?? []).filter((t) => !filterEditor || t.editor_id === filterEditor),
    [tasks, filterEditor],
  );
  const byStatus = (s: TaskStatus) => filtered.filter((t) => t.status === s);

  async function move(t: Task, status: TaskStatus) {
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update task.");
    }
  }
  async function del(t: Task) {
    if (!window.confirm(`Delete "${t.title}"? This can't be undone.`)) return;
    try {
      await api(`/tasks/${t.id}`, { method: "DELETE" });
      toast.success("Task deleted.");
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete task.");
    }
  }

  return (
    <section className="screen">
      <div className="toolbar">
        <select
          className="t"
          style={{ maxWidth: 240 }}
          value={filterEditor}
          onChange={(e) => setFilterEditor(e.target.value)}
        >
          <option value="">All team members</option>
          {(editors ?? []).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <div className="seg" style={{ margin: 0 }}>
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>🗂️ Board</button>
          <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")}>📅 Calendar</button>
        </div>
        <div className="spacer" />
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          ＋ Add Task
        </button>
      </div>

      {tasks === null ? (
        <div className="hint">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13.5 }}>
          No tasks yet. Click <b>＋ Add Task</b> to assign your first daily task to a team member.
        </div>
      ) : view === "calendar" ? (
        <TaskCalendar tasks={filtered} onOpen={openTask} />
      ) : (
        <div className="task-board">
          {COLUMNS.map((col, ci) => {
            const items = byStatus(col.key);
            return (
              <div className="task-col" key={col.key}>
                <div className="task-colhead">
                  <span className={"tdot " + col.key} /> {col.label}
                  <span className="task-count">{items.length}</span>
                </div>
                {items.map((t) => {
                  const overdue =
                    t.status !== "done" && t.due_date && t.due_date < today();
                  return (
                    <div className="task-card" key={t.id} onClick={() => { setEditing(t); setModalOpen(true); }}>
                      <div className="task-top">
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <span className={"task-pri " + t.priority}>{PRI_LABEL[t.priority]}</span>
                          {t.post_id && <span className="task-postbadge" title="Auto-created from a post">📄 Post</span>}
                          {t.recurrence !== "none" && <span className="task-recur" title={`Repeats ${t.recurrence}`}>🔁</span>}
                        </span>
                        <button
                          className="task-x"
                          title="Delete"
                          onClick={(e) => { e.stopPropagation(); del(t); }}
                        >
                          🗑
                        </button>
                      </div>
                      <div className="task-title">{t.title}</div>
                      <div className="task-meta">
                        <Assignee name={t.editor_name} image={t.editor_image} />
                        {t.due_date && (
                          <span className={"task-due" + (overdue ? " over" : "")}>📅 {t.due_date}</span>
                        )}
                        {t.subtask_total > 0 && (
                          <span className={"task-check" + (t.subtask_done === t.subtask_total ? " full" : "")}>
                            ☑ {t.subtask_done}/{t.subtask_total}
                          </span>
                        )}
                      </div>
                      <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                        {ci > 0 && (
                          <button className="linkbtn" onClick={() => move(t, COLUMNS[ci - 1].key)}>
                            ← {COLUMNS[ci - 1].label}
                          </button>
                        )}
                        {ci < COLUMNS.length - 1 && (
                          <button className="linkbtn" onClick={() => move(t, COLUMNS[ci + 1].key)}>
                            {COLUMNS[ci + 1].label} →
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {items.length === 0 && <div className="task-empty">Nothing here</div>}
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <TaskModal
          task={editing}
          editors={editors ?? []}
          onClose={() => { setModalOpen(false); refetch(); }}
          onSaved={() => { setModalOpen(false); refetch(); }}
        />
      )}
    </section>
  );
}

function TaskModal({
  task,
  editors,
  onClose,
  onSaved,
}: {
  task: Task | null;
  editors: Editor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [editorId, setEditorId] = useState(task?.editor_id ?? "");
  const [dueDate, setDueDate] = useState(task?.due_date ?? today());
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "medium");
  const [recurrence, setRecurrence] = useState<"none" | "daily" | "weekly">(task?.recurrence ?? "none");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setErr("Give the task a title."); return; }
    setSaving(true);
    setErr(null);
    const payload = {
      title: title.trim(),
      description,
      editorId: editorId || null,
      dueDate: dueDate || null,
      priority,
      recurrence,
      status,
    };
    try {
      if (editing) {
        await api(`/tasks/${task!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast.success("Task updated.");
      } else {
        await api("/tasks", { method: "POST", body: JSON.stringify(payload) });
        toast.success("Task created.");
      }
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Could not save task.");
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title={editing ? "Edit Task" : "Add Task"}>
      <form onSubmit={submit}>
        <div className="field">
          <label className="f">Task <span className="req">*</span></label>
          <input className="t" placeholder="e.g. Edit Diabetes reel" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label className="f">Details</label>
          <textarea className="t" placeholder="Optional notes…" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid g3">
          <div className="field">
            <label className="f">Assign to</label>
            <select className="t" value={editorId} onChange={(e) => setEditorId(e.target.value)}>
              <option value="">Unassigned</option>
              {editors.map((ed) => (
                <option key={ed.id} value={ed.id}>{ed.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="f">Due date</label>
            <input className="t" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="field">
            <label className="f">Priority</label>
            <select className="t" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="field">
            <label className="f">Repeat</label>
            <select className="t" value={recurrence} onChange={(e) => setRecurrence(e.target.value as "none" | "daily" | "weekly")}>
              <option value="none">Doesn't repeat</option>
              <option value="daily">🔁 Daily</option>
              <option value="weekly">🔁 Weekly</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label className="f">Status</label>
          <div className="statusseg">
            {COLUMNS.map((c) => (
              <button type="button" key={c.key} className={status === c.key ? "on" : ""} onClick={() => setStatus(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {editing && task && <Checklist taskId={task.id} />}
        {editing && task && <Comments taskId={task.id} />}
        {err && <p className="login-err" style={{ marginTop: 10 }}>{err}</p>}
        <div className="formfoot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Checklist({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<Subtask[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState("");

  useEffect(() => {
    let cancel = false;
    api<{ subtasks: Subtask[] }>(`/tasks/${taskId}/subtasks`)
      .then((d) => { if (!cancel) setItems(d.subtasks); })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [taskId]);

  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  async function add() {
    const t = newTitle.trim();
    if (!t) return;
    try {
      const { subtask } = await api<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks`, { method: "POST", body: JSON.stringify({ title: t }) });
      setItems((x) => [...x, subtask]);
      setNewTitle("");
    } catch { toast.error("Could not add item."); }
  }
  async function toggle(s: Subtask) {
    try {
      const { subtask } = await api<{ subtask: Subtask }>(`/subtasks/${s.id}`, { method: "PATCH", body: JSON.stringify({ done: !s.done }) });
      setItems((x) => x.map((i) => (i.id === s.id ? subtask : i)));
    } catch { toast.error("Could not update item."); }
  }
  async function del(s: Subtask) {
    try {
      await api(`/subtasks/${s.id}`, { method: "DELETE" });
      setItems((x) => x.filter((i) => i.id !== s.id));
    } catch { toast.error("Could not delete item."); }
  }

  return (
    <div className="field">
      <label className="f">
        Checklist {items.length > 0 && <span style={{ fontWeight: 500, color: "var(--faint)" }}>· {done}/{items.length} done</span>}
      </label>
      {items.length > 0 && (
        <div className="chk-bar"><div className="chk-fill" style={{ width: `${pct}%` }} /></div>
      )}
      <div className="chk-list">
        {items.map((s) => (
          <div className="chk-row" key={s.id}>
            <button type="button" className={"chk-box" + (s.done ? " on" : "")} onClick={() => toggle(s)} aria-label="Toggle">{s.done ? "✓" : ""}</button>
            <span className={"chk-title" + (s.done ? " done" : "")}>{s.title}</span>
            <button type="button" className="chk-del" onClick={() => del(s)} title="Remove">✕</button>
          </div>
        ))}
        {loading && <div className="hint">Loading…</div>}
        {!loading && items.length === 0 && <div className="hint" style={{ marginTop: 2 }}>Break this task into steps.</div>}
      </div>
      <div className="chk-add">
        <input className="t" placeholder="Add checklist item…" value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" className="btn" onClick={add} disabled={!newTitle.trim()}>Add</button>
      </div>
    </div>
  );
}

function Comments({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancel = false;
    api<{ comments: TaskComment[] }>(`/tasks/${taskId}/comments`)
      .then((d) => { if (!cancel) setItems(d.comments); })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [taskId]);

  async function send() {
    const b = text.trim();
    if (!b) return;
    setSending(true);
    try {
      const { comment } = await api<{ comment: TaskComment }>(`/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ body: b }) });
      setItems((x) => [...x, comment]);
      setText("");
    } catch { toast.error("Could not post comment."); }
    finally { setSending(false); }
  }
  async function del(c: TaskComment) {
    try {
      await api(`/comments/${c.id}`, { method: "DELETE" });
      setItems((x) => x.filter((i) => i.id !== c.id));
    } catch { toast.error("Could not delete comment."); }
  }

  return (
    <div className="field">
      <label className="f">Comments {items.length > 0 && <span style={{ fontWeight: 500, color: "var(--faint)" }}>· {items.length}</span>}</label>
      <div className="cmt-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && items.length === 0 && <div className="hint" style={{ marginTop: 2 }}>No comments yet — start the discussion.</div>}
        {items.map((c) => (
          <div className="cmt" key={c.id}>
            <span className="cmt-ava">{(c.author_name ?? "?").charAt(0).toUpperCase()}</span>
            <div className="cmt-body">
              <div className="cmt-head">
                <b>{c.author_name ?? "Someone"}</b>
                <span>{relTime(c.created_at)}</span>
                <button type="button" className="cmt-del" onClick={() => del(c)} title="Delete">✕</button>
              </div>
              <div className="cmt-text">{c.body}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="cmt-add">
        <input className="t" placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }} />
        <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !text.trim()}>Post</button>
      </div>
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function TaskCalendar({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  const [offset, setOffset] = useState(0);
  const now = new Date();
  const view = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = view.getFullYear();
  const month = view.getMonth();
  const monthName = view.toLocaleString("default", { month: "long", year: "numeric" });

  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay: Record<string, Task[]> = {};
  for (const t of tasks) if (t.due_date) (byDay[t.due_date] ||= []).push(t);
  const todayS = ymd(now);
  const noDate = tasks.filter((t) => !t.due_date).length;

  return (
    <div className="card pad">
      <div className="cal-head">
        <button className="btn icon" onClick={() => setOffset((o) => o - 1)} aria-label="Previous month">‹</button>
        <h3 className="cal-title">{monthName}</h3>
        <button className="btn icon" onClick={() => setOffset((o) => o + 1)} aria-label="Next month">›</button>
        {offset !== 0 && <button className="linkbtn" onClick={() => setOffset(0)}>Today</button>}
        <div className="spacer" />
        {noDate > 0 && <span className="hint" style={{ margin: 0 }}>{noDate} without a due date</span>}
      </div>
      <div className="cal-grid cal-dow">{WEEKDAYS.map((w) => <div key={w} className="cal-dowc">{w}</div>)}</div>
      <div className="cal-grid">
        {cells.map((d, i) =>
          d === null ? (
            <div key={i} className="cal-cell empty" />
          ) : (
            <div key={i} className={"cal-cell" + (ymd(d) === todayS ? " today" : "")}>
              <div className="cal-day">{d.getDate()}</div>
              <div className="cal-items">
                {(byDay[ymd(d)] ?? []).slice(0, 3).map((t) => (
                  <button key={t.id} className={"cal-task " + t.status} onClick={() => onOpen(t)} title={t.title}>
                    {t.title}
                  </button>
                ))}
                {(byDay[ymd(d)]?.length ?? 0) > 3 && <div className="cal-more">+{byDay[ymd(d)]!.length - 3} more</div>}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
