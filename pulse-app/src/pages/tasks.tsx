import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { usePosts } from "@/lib/use-posts";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import { toast } from "sonner";
import type { Task, TaskStatus, TaskPriority, TaskType, ContentFormat, Editor, Subtask, TaskComment } from "@/lib/types";

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

const TYPE_LABEL: Record<TaskType, string> = {
  content: "Content",
  short_task: "Short task",
  emergency: "Emergency",
  general: "General",
};
const TYPE_ICON: Record<TaskType, string> = { content: "📄", short_task: "⚡", emergency: "🚨", general: "🗒️" };

// Second, independent classifier — what production format the work is.
// Optional, so every lookup goes through `?? null`-safe call sites.
const FORMAT_LABEL: Record<ContentFormat, string> = {
  video: "Video", image: "Image", shoot: "Shoot", other: "Other",
};
const FORMAT_ICON: Record<ContentFormat, string> = { video: "🎬", image: "🖼️", shoot: "📷", other: "🔧" };

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function today() {
  // Local calendar date as YYYY-MM-DD (Date.now avoided elsewhere but fine here).
  return ymd(new Date());
}
function addDays(base: Date, n: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

type DueTab = "all" | "overdue" | "today" | "tomorrow" | "week";
const DUE_TABS: { key: DueTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "overdue", label: "⚠️ Overdue" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "week", label: "This week" },
];

// The current calendar week, Sunday→Saturday — matches the day columns used
// by <TaskCalendar> below.
function weekRange(now: Date) {
  const start = addDays(now, -now.getDay());
  const end = addDays(start, 6);
  return { start: ymd(start), end: ymd(end) };
}

function matchesDueTab(t: Task, tab: DueTab, now: Date) {
  if (tab === "all") return true;
  if (!t.due_date) return false;
  const todayS = ymd(now);
  if (tab === "overdue") return t.status !== "done" && t.due_date < todayS;
  if (tab === "today") return t.due_date === todayS;
  if (tab === "tomorrow") return t.due_date === ymd(addDays(now, 1));
  if (tab === "week") {
    const { start, end } = weekRange(now);
    return t.due_date >= start && t.due_date <= end;
  }
  return true;
}

const VIEW_KEY_PREFIX = "pulse-tasks-view:";

// Time-budget countdown (Phase 1) — budget_hours/budget_started_at are set
// server-side from admin-configured rules; this just renders the clock.
// A future budget_started_at (deferred acceptance, see § Accept) shows as
// "starts at …" instead of counting down.
function budgetInfo(t: Task, nowMs: number) {
  if (t.budget_hours == null || !t.budget_started_at || t.status === "done") return null;
  const startMs = new Date(t.budget_started_at).getTime();
  if (startMs > nowMs) {
    return { scheduled: true, over: false, label: `Starts ${new Date(startMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` };
  }
  const deadlineMs = startMs + t.budget_hours * 3_600_000;
  const remainingMs = deadlineMs - nowMs;
  const over = remainingMs < 0;
  const absMs = Math.abs(remainingMs);
  const h = Math.floor(absMs / 3_600_000);
  const m = Math.floor((absMs % 3_600_000) / 60_000);
  return { scheduled: false, over, label: h > 0 ? `${h}h ${m}m` : `${m}m` };
}

// Office hours the acceptance dual-confirmation checks against.
const OFFICE_OPEN_HOUR = 9;
const OFFICE_CLOSE_HOUR = 18;
function officeCloseToday(from: Date) {
  const d = new Date(from);
  d.setHours(OFFICE_CLOSE_HOUR, 0, 0, 0);
  return d;
}
function nineAmTomorrow(from: Date) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(OFFICE_OPEN_HOUR, 0, 0, 0);
  return d;
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
  const { user } = useAuth();
  const { active } = useWorkspaces();
  const role = active?.role;

  const [filterEditor, setFilterEditor] = useState("");
  const [filterType, setFilterType] = useState<TaskType | "">("");
  const [filterFormat, setFilterFormat] = useState<ContentFormat | "">("");
  const [dueTab, setDueTab] = useState<DueTab>("all");
  const [view, setView] = useState<"board" | "calendar">("board");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const openTask = (t: Task) => { setEditing(t); setModalOpen(true); };
  // Dual-confirmation prompt when accepting would run the budget past office
  // close — null when no prompt is showing.
  const [acceptPrompt, setAcceptPrompt] = useState<{ task: Task; closeIn: string } | null>(null);

  // "My Tasks" vs "Team" — editors default to their own work, admins default
  // to the whole team's (since they assign & monitor it). Either can toggle;
  // this is not an access restriction. Persisted per-user once they switch.
  const viewKey = user ? `${VIEW_KEY_PREFIX}${user.id}` : null;
  const [scope, setScope] = useState<"mine" | "team">(() => {
    const stored = viewKey ? window.localStorage.getItem(viewKey) : null;
    if (stored === "mine" || stored === "team") return stored;
    return role === "editor" ? "mine" : "team";
  });
  function setScopeAndPersist(next: "mine" | "team") {
    setScope(next);
    if (viewKey) window.localStorage.setItem(viewKey, next);
  }

  const now = useMemo(() => new Date(), []);
  // Live clock for the budget countdown — ticks once a minute so cards stay
  // roughly current without hammering re-renders.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const filtered = useMemo(
    () =>
      (tasks ?? []).filter((t) => {
        if (scope === "mine" && t.editor_id !== user?.editorId) return false;
        if (filterEditor && t.editor_id !== filterEditor) return false;
        if (filterType && t.task_type !== filterType) return false;
        if (filterFormat && t.content_format !== filterFormat) return false;
        if (!matchesDueTab(t, dueTab, now)) return false;
        return true;
      }),
    [tasks, scope, user?.editorId, filterEditor, filterType, filterFormat, dueTab, now],
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

  async function acceptTask(t: Task, startAt: Date) {
    try {
      await api(`/tasks/${t.id}/accept`, { method: "POST", body: JSON.stringify({ startAt: startAt.toISOString() }) });
      toast.success(startAt.getTime() > Date.now() ? "Accepted — starts as scheduled." : "Accepted — timer started.");
      setAcceptPrompt(null);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not accept this task.");
    }
  }

  // If accepting now would run past office close, ask which start time to use.
  function handleAccept(t: Task) {
    const now = new Date();
    if (t.budget_hours != null) {
      const wouldEnd = new Date(now.getTime() + t.budget_hours * 3_600_000);
      const close = officeCloseToday(now);
      if (wouldEnd > close || now >= close) {
        const mins = Math.max(0, Math.round((close.getTime() - now.getTime()) / 60_000));
        setAcceptPrompt({ task: t, closeIn: mins > 0 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : "0m" });
        return;
      }
    }
    acceptTask(t, now);
  }

  return (
    <section className="screen">
      <div className="toolbar">
        <div className="seg" style={{ margin: 0 }}>
          <button className={scope === "mine" ? "on" : ""} onClick={() => setScopeAndPersist("mine")}>🙋 My Tasks</button>
          <button className={scope === "team" ? "on" : ""} onClick={() => setScopeAndPersist("team")}>👥 Team</button>
        </div>
        <select
          className="t"
          style={{ maxWidth: 200 }}
          value={filterEditor}
          onChange={(e) => setFilterEditor(e.target.value)}
        >
          <option value="">All team members</option>
          {(editors ?? []).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <select
          className="t"
          style={{ maxWidth: 170 }}
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as TaskType | "")}
        >
          <option value="">All task types</option>
          {(Object.keys(TYPE_LABEL) as TaskType[]).map((tt) => (
            <option key={tt} value={tt}>{TYPE_ICON[tt]} {TYPE_LABEL[tt]}</option>
          ))}
        </select>
        <select
          className="t"
          style={{ maxWidth: 160 }}
          value={filterFormat}
          onChange={(e) => setFilterFormat(e.target.value as ContentFormat | "")}
        >
          <option value="">All formats</option>
          {(Object.keys(FORMAT_LABEL) as ContentFormat[]).map((f) => (
            <option key={f} value={f}>{FORMAT_ICON[f]} {FORMAT_LABEL[f]}</option>
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

      <div className="seg duetabs">
        {DUE_TABS.map((d) => (
          <button key={d.key} className={dueTab === d.key ? "on" : ""} onClick={() => setDueTab(d.key)}>
            {d.label}
          </button>
        ))}
      </div>

      {scope === "mine" && !user?.editorId && (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
          Your account isn't linked to a team member yet, so there's nothing to show here. Ask an admin to
          link you under Settings → User management.
        </div>
      )}

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
                          <span className={"task-typebadge " + t.task_type} title={TYPE_LABEL[t.task_type]}>
                            {TYPE_ICON[t.task_type]} {TYPE_LABEL[t.task_type]}
                          </span>
                          {t.content_format && (
                            <span className="task-formatbadge" title={FORMAT_LABEL[t.content_format]}>
                              {FORMAT_ICON[t.content_format]} {FORMAT_LABEL[t.content_format]}
                            </span>
                          )}
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
                        {t.editor_id && !t.accepted ? (
                          user?.editorId === t.editor_id ? (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={(e) => { e.stopPropagation(); handleAccept(t); }}
                            >
                              ✓ Accept
                            </button>
                          ) : (
                            <span className="task-check" title="Waiting for the assignee to accept">⏳ Pending accept</span>
                          )
                        ) : (() => {
                          const b = budgetInfo(t, nowMs);
                          if (!b) return null;
                          return (
                            <span className={"task-timer" + (b.over ? " over" : "")} title={b.scheduled ? "Timer hasn't started yet" : b.over ? "Over its time budget" : "Time remaining in its budget"}>
                              ⏱ {b.scheduled ? b.label : b.over ? `+${b.label}` : `${b.label} left`}
                            </span>
                          );
                        })()}
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

      {acceptPrompt && (
        <div className="modal-bg show" onClick={() => setAcceptPrompt(null)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="mhead">
              <span style={{ fontSize: 18 }}>⏰</span>
              <h3>This runs past office hours</h3>
              <button className="x" onClick={() => setAcceptPrompt(null)}>×</button>
            </div>
            <div className="mbody">
              <p style={{ margin: "0 0 4px", fontSize: 13.5, lineHeight: 1.6 }}>
                <b>{acceptPrompt.task.title}</b> needs <b>{acceptPrompt.task.budget_hours}h</b>, but office
                hours close in <b>{acceptPrompt.closeIn}</b> (6:00 PM). Starting now means finishing outside
                office hours.
              </p>
            </div>
            <div className="mfoot">
              <button type="button" className="btn" onClick={() => { acceptTask(acceptPrompt.task, nineAmTomorrow(new Date())); }}>
                Start 9 AM tomorrow
              </button>
              <button type="button" className="btn btn-primary" onClick={() => { acceptTask(acceptPrompt.task, new Date()); }}>
                Start now anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function TaskModal({
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
  const [taskType, setTaskType] = useState<TaskType>(task?.task_type ?? "general");
  const [contentFormat, setContentFormat] = useState<ContentFormat | "">(task?.content_format ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-created (post-linked) tasks are always "content" — not user-editable.
  const typeLocked = Boolean(task?.post_id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setErr("Give the task a title."); return; }
    setSaving(true);
    setErr(null);
    const payload: Record<string, unknown> = {
      title: title.trim(),
      description,
      editorId: editorId || null,
      dueDate: dueDate || null,
      priority,
      recurrence,
      status,
      contentFormat: contentFormat || null,
    };
    if (!typeLocked) payload.taskType = taskType;
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
          <div className="field">
            <label className="f">Task type</label>
            {typeLocked ? (
              <div className="t" style={{ display: "flex", alignItems: "center", color: "var(--muted)" }} title="Set automatically — this task is linked to a post.">
                {TYPE_ICON.content} Content (auto)
              </div>
            ) : (
              <select className="t" value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
                <option value="general">🗒️ General</option>
                <option value="short_task">⚡ Short task</option>
                <option value="emergency">🚨 Emergency</option>
              </select>
            )}
          </div>
          <div className="field">
            <label className="f">Content format</label>
            <select className="t" value={contentFormat} onChange={(e) => setContentFormat(e.target.value as ContentFormat | "")}>
              <option value="">None</option>
              <option value="video">🎬 Video</option>
              <option value="image">🖼️ Image</option>
              <option value="shoot">📷 Shoot</option>
              <option value="other">🔧 Other</option>
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
        {editing && task?.budget_hours != null && (
          <div className="field">
            <label className="f">Time budget</label>
            <div className="autofield">
              ⏱ {task.budget_hours}h, started {new Date(task.budget_started_at!).toLocaleString()} — set by your admin, not editable here.
            </div>
          </div>
        )}
        {editing && task && !task.post_id && <LinkPostControl taskId={task.id} onLinked={onSaved} />}
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

// Turns a manual task into a Social Media task by linking it to an existing
// post — after this it behaves like an auto-created task (locked to
// task_type "content", shows the 📄 Post badge, appears in Social Media).
function LinkPostControl({ taskId, onLinked }: { taskId: string; onLinked: () => void }) {
  const { posts } = usePosts();
  const [postId, setPostId] = useState("");
  const [linking, setLinking] = useState(false);

  async function link() {
    if (!postId) return;
    setLinking(true);
    try {
      await api(`/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ postId }) });
      toast.success("Linked — this is now a Social Media task.");
      onLinked();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not link that post.");
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="field">
      <label className="f">Link to a post</label>
      <div style={{ display: "flex", gap: 8 }}>
        <select className="t" value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">Choose a post…</option>
          {(posts ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
        <button type="button" className="btn" onClick={link} disabled={!postId || linking}>
          {linking ? "Linking…" : "Link"}
        </button>
      </div>
      <div className="hint" style={{ marginTop: 5 }}>
        Makes this task track that post's Social Media work — it'll switch to Content type and show up in Social Media tracking.
      </div>
    </div>
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
