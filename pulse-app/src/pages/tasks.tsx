import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, useDraggable, useDroppable, closestCorners,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useContentFormats } from "@/lib/use-content-formats";
import { noteTaskSeen } from "@/lib/use-task-notify";
import { breakOffsetMs } from "@/lib/task-timing";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { usePosts } from "@/lib/use-posts";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import { toast } from "sonner";
import type { Task, TaskStatus, TaskPriority, TaskType, ContentFormatDef, Editor, Subtask, TaskComment } from "@/lib/types";

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
  general: "General",
};
const TYPE_ICON: Record<TaskType, string> = { content: "📄", short_task: "⚡", general: "🗒️" };

// Second, independent classifier — what production format the work is. Now a
// live, admin-manageable list (task_content_format) instead of a fixed enum —
// see useContentFormats(). Optional, so every lookup goes through `?? null`.

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
// "starts at …" instead of counting down. The assignee's break time (if any)
// pushes the deadline out — a break pauses every task they have running.
function budgetInfo(t: Task, nowMs: number) {
  if (t.budget_hours == null || !t.budget_started_at || t.status === "done") return null;
  const startMs = new Date(t.budget_started_at).getTime();
  if (startMs > nowMs) {
    return { scheduled: true, over: false, label: `Starts ${new Date(startMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` };
  }
  const deadlineMs = startMs + t.budget_hours * 3_600_000 + breakOffsetMs(t, nowMs);
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

// Daily-workload double-approval: one 3h job is normal, a second pushes past
// half a day (needs a heads-up), a third is basically the whole 9h office day
// (needs a stronger one). Same idea however the acceptance happens — accepted
// via the explicit button, or self-assigned straight from Add/Edit Task.
const WORKLOAD_WARN_HOURS = 6;
const WORKLOAD_FULL_HOURS = 9;
function classifyWorkload(totalHours: number): 0 | 1 | 2 {
  if (totalHours > WORKLOAD_FULL_HOURS) return 2;
  if (totalHours > WORKLOAD_WARN_HOURS) return 1;
  return 0;
}
function fmtHours(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Whole days a due date is past today. Both inputs are YYYY-MM-DD; compared via
// Date.UTC so the delta is a clean integer, DST-proof. Returns >= 1 for an
// overdue task (due-today is not overdue — matches the Progress Path < boundary).
function daysOverdue(due: string): number {
  const [dy, dm, dd] = due.split("-").map(Number);
  const [ty, tm, td] = today().split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
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

// A status column that accepts dropped cards; highlights while hovered.
function DroppableColumn({ id, children }: { id: TaskStatus; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={"task-col" + (isOver ? " dnd-over" : "")}>{children}</div>;
}

// Wraps a card so it can be dragged. The drag listeners live on this wrapper;
// the inner card keeps its own onClick (tap → open) because the sensors only
// start a drag past a movement/hold threshold, so a plain tap still clicks.
function DraggableCard({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="dnd-card"
      style={{ opacity: isDragging ? 0.4 : 1, touchAction: "manipulation" }}
    >
      {children}
    </div>
  );
}

export function TasksPage() {
  const { tasks, refetch } = useTasks();
  const { editors } = useEditors();
  const { contentFormats } = useContentFormats();
  const { user } = useAuth();
  const { active } = useWorkspaces();
  const role = active?.role;
  // Viewers are read-only (the backend already 403s their writes); hide the
  // status-move controls from them so the affordance matches the permission.
  const canWrite = active?.role !== "viewer";
  // Only the person a task is assigned to can move it between columns — not
  // whoever assigned it, not an admin (the backend enforces this too).
  const canMoveStatus = (t: Task) => canWrite && !!user?.editorId && t.editor_id === user.editorId;

  const [filterEditor, setFilterEditor] = useState("");
  const [filterType, setFilterType] = useState<TaskType | "">("");
  const [filterFormat, setFilterFormat] = useState("");
  const [dueTab, setDueTab] = useState<DueTab>("all");
  // Optimistic status overrides (task id → status) applied while a move's PATCH
  // is in flight, so a drop or a link-click moves the card immediately.
  const [pending, setPending] = useState<Record<string, TaskStatus>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    // Mouse: small drag threshold so clicks still open the card.
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // Touch: press-and-hold to drag, so tapping and vertical scrolling still work.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const [view, setView] = useState<"board" | "calendar">("board");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const openTask = (t: Task) => { setEditing(t); setModalOpen(true); };
  // Dual-confirmation prompt when accepting would run the budget past office
  // close — null when no prompt is showing.
  const [acceptPrompt, setAcceptPrompt] = useState<{ task: Task; closeIn: string; alreadyClosed: boolean } | null>(null);
  // Double-approval prompt when accepting would push the assignee's committed
  // hours for that due date past a normal day's worth of work.
  const [workloadPrompt, setWorkloadPrompt] = useState<{ task: Task; total: number; tier: 1 | 2 } | null>(null);

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
  // Apply any in-flight optimistic status before filtering, so the board (and
  // the per-column counts derived from it) reflect a drop immediately.
  const effective = useMemo(
    () => (tasks ?? []).map((t) => (pending[t.id] ? { ...t, status: pending[t.id] } : t)),
    [tasks, pending],
  );
  const filtered = useMemo(
    () =>
      effective.filter((t) => {
        if (scope === "mine" && t.editor_id !== user?.editorId) return false;
        if (filterEditor && t.editor_id !== filterEditor) return false;
        if (filterType && t.task_type !== filterType) return false;
        if (filterFormat && t.content_format_id !== filterFormat) return false;
        if (!matchesDueTab(t, dueTab, now)) return false;
        return true;
      }),
    [effective, scope, user?.editorId, filterEditor, filterType, filterFormat, dueTab, now],
  );
  const byStatus = (s: TaskStatus) => filtered.filter((t) => t.status === s);

  // Both the ←/→ links and drag-and-drop call this — one PATCH path, so the
  // backend side effects (completion timestamp, recurring spawn, activity log)
  // are identical however the card is moved. Optimistic: the card moves now;
  // on failure it reverts to its original column and an error is surfaced.
  async function move(t: Task, status: TaskStatus) {
    if (t.status === status) return;
    if (!canMoveStatus(t)) { toast.error("Only the person this task is assigned to can move it."); return; }
    setPending((p) => ({ ...p, [t.id]: status }));
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update task.");
    } finally {
      setPending((p) => { const n = { ...p }; delete n[t.id]; return n; });
    }
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const overId = e.over?.id;
    if (!overId) return;
    const status = overId as TaskStatus;
    if (!COLUMNS.some((c) => c.key === status)) return;
    const t = (tasks ?? []).find((x) => x.id === String(e.active.id));
    if (t) move(t, status);
  }
  const activeTask = activeId ? effective.find((t) => t.id === activeId) : null;
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
      if (user) noteTaskSeen(user.id, t.id);
      setAcceptPrompt(null);
      // The 60s tick won't have caught up yet — without this, a task accepted
      // "now" briefly (mis)renders as scheduled-for-later until it does.
      setNowMs(Date.now());
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not accept this task.");
    }
  }

  // Sum of this editor's other accepted, not-done tasks due the same day —
  // what they've already committed to before this one.
  function workloadTotalFor(editorId: string, dueDate: string, excludeId: string) {
    return (tasks ?? [])
      .filter((x) => x.editor_id === editorId && x.due_date === dueDate && x.accepted && x.status !== "done" && x.id !== excludeId && x.budget_hours != null)
      .reduce((n, x) => n + Number(x.budget_hours), 0);
  }

  // Accepting runs two checks in sequence, either of which can pause for a
  // confirmation: first whether it overloads the day, then whether its clock
  // would run past office close (including after close has already passed).
  function handleAccept(t: Task) {
    if (t.editor_id && t.due_date && t.budget_hours != null) {
      const total = workloadTotalFor(t.editor_id, t.due_date, t.id) + Number(t.budget_hours);
      const tier = classifyWorkload(total);
      if (tier === 1 || tier === 2) {
        setWorkloadPrompt({ task: t, total, tier });
        return;
      }
    }
    checkOfficeHours(t);
  }

  function checkOfficeHours(t: Task) {
    const now = new Date();
    if (t.budget_hours != null) {
      const close = officeCloseToday(now);
      const alreadyClosed = now >= close;
      const wouldEnd = new Date(now.getTime() + t.budget_hours * 3_600_000);
      if (alreadyClosed || wouldEnd > close) {
        const mins = alreadyClosed ? 0 : Math.max(0, Math.round((close.getTime() - now.getTime()) / 60_000));
        setAcceptPrompt({ task: t, closeIn: `${Math.floor(mins / 60)}h ${mins % 60}m`, alreadyClosed });
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
          onChange={(e) => setFilterFormat(e.target.value)}
        >
          <option value="">All formats</option>
          {(contentFormats ?? []).map((f) => (
            <option key={f.id} value={f.id}>{f.icon} {f.name}</option>
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
        <div className="task-board">
          {COLUMNS.map((col, ci) => {
            const items = byStatus(col.key);
            return (
              <DroppableColumn id={col.key} key={col.key}>
                <div className="task-colhead">
                  <span className={"tdot " + col.key} /> {col.label}
                  <span className="task-count">{items.length}</span>
                </div>
                {items.map((t) => {
                  const overdue =
                    t.status !== "done" && t.due_date && t.due_date < today();
                  const cardInner = (
                    <div className={"task-card pri-" + t.priority} key={t.id} onClick={() => { setEditing(t); setModalOpen(true); }}>
                      <div className="task-top">
                        <span className="task-pri-group">
                          <span className={"task-pri-dot " + t.priority} />
                          <span className={"task-pri-label" + (t.priority === "high" ? " high" : "")}>{PRI_LABEL[t.priority]}</span>
                        </span>
                        <span className="task-flags">
                          {t.post_id && <span title="Auto-created from a post">📄</span>}
                          {t.recurrence !== "none" && <span title={`Repeats ${t.recurrence}`}>🔁</span>}
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
                      <div className="task-kind">
                        <span>{TYPE_ICON[t.task_type]} {TYPE_LABEL[t.task_type]}</span>
                        {t.content_format_name && (
                          <>
                            <span className="dot-sep">·</span>
                            <span>{t.content_format_icon} {t.content_format_name}</span>
                          </>
                        )}
                      </div>
                      <div className="task-meta">
                        <Assignee name={t.editor_name} image={t.editor_image} />
                        {t.due_date && (
                          <span className={"task-due" + (overdue ? " over" : "")}>
                            📅 {t.due_date}
                            {overdue && ` · ${daysOverdue(t.due_date!)}d overdue`}
                          </span>
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
                            <span className={"task-timer" + (b.over ? " over" : "")} title={b.scheduled ? "Timer hasn't started yet" : b.over ? "Ran past its allotted time — needs follow-up" : "Time remaining"}>
                              {b.scheduled ? `⏱ ${b.label}` : b.over ? `⚠ Pending — ${b.label} over` : `⏱ ${b.label} left`}
                            </span>
                          );
                        })()}
                        {t.subtask_total > 0 && (
                          <span className={"task-check" + (t.subtask_done === t.subtask_total ? " full" : "")}>
                            ☑ {t.subtask_done}/{t.subtask_total}
                          </span>
                        )}
                      </div>
                      {canMoveStatus(t) && (
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
                      )}
                    </div>
                  );
                  return canMoveStatus(t) ? (
                    <DraggableCard id={t.id} key={t.id}>{cardInner}</DraggableCard>
                  ) : cardInner;
                })}
                {items.length === 0 && <div className="task-empty">Nothing here</div>}
              </DroppableColumn>
            );
          })}
        </div>
          <DragOverlay dropAnimation={null}>
            {activeTask ? (
              <div className={"task-card dnd-overlay pri-" + activeTask.priority}>
                <div className="task-top">
                  <span className="task-pri-group">
                    <span className={"task-pri-dot " + activeTask.priority} />
                    <span className={"task-pri-label" + (activeTask.priority === "high" ? " high" : "")}>{PRI_LABEL[activeTask.priority]}</span>
                  </span>
                </div>
                <div className="task-title">{activeTask.title}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
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
              <h3>{acceptPrompt.alreadyClosed ? "Office hours have ended for today" : "This runs past office hours"}</h3>
              <button className="x" onClick={() => setAcceptPrompt(null)}>×</button>
            </div>
            <div className="mbody">
              <p style={{ margin: "0 0 4px", fontSize: 13.5, lineHeight: 1.6 }}>
                {acceptPrompt.alreadyClosed ? (
                  <>
                    <b>{acceptPrompt.task.title}</b> needs <b>{acceptPrompt.task.budget_hours}h</b>, and office
                    hours already closed for today (6:00 PM). Starting now means the whole thing runs
                    outside office hours.
                  </>
                ) : (
                  <>
                    <b>{acceptPrompt.task.title}</b> needs <b>{acceptPrompt.task.budget_hours}h</b>, but office
                    hours close in <b>{acceptPrompt.closeIn}</b> (6:00 PM). Starting now means finishing outside
                    office hours.
                  </>
                )}
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

      {workloadPrompt && (
        <div className="modal-bg show" onClick={() => setWorkloadPrompt(null)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="mhead">
              <span style={{ fontSize: 18 }}>{workloadPrompt.tier === 2 ? "🔴" : "⚠️"}</span>
              <h3>{workloadPrompt.tier === 2 ? "That's a full day already" : "Heavy day ahead"}</h3>
              <button className="x" onClick={() => setWorkloadPrompt(null)}>×</button>
            </div>
            <div className="mbody">
              <p style={{ margin: "0 0 4px", fontSize: 13.5, lineHeight: 1.6 }}>
                With <b>{workloadPrompt.task.title}</b>, <b>{workloadPrompt.task.editor_name}</b> would have about{" "}
                <b>{fmtHours(workloadPrompt.total)}h</b> due <b>{workloadPrompt.task.due_date}</b> —{" "}
                {workloadPrompt.tier === 2
                  ? "that's a full office day (9h) or more, spread across several tasks. It likely can't all get finished today."
                  : "more than half the office day already spoken for across other tasks."}
              </p>
            </div>
            <div className="mfoot">
              <button type="button" className="btn" onClick={() => setWorkloadPrompt(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { const t = workloadPrompt.task; setWorkloadPrompt(null); checkOfficeHours(t); }}
              >
                Accept anyway
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
  const { user } = useAuth();
  const { isAdmin } = useWorkspaces();
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  // Only admins can assign work to someone else — a non-admin creating a task
  // just gets it assigned to themselves; editing an existing task never
  // silently reassigns it (falls back to whatever it already was, even null).
  const [editorId, setEditorId] = useState(() => {
    if (editing) return task?.editor_id ?? "";
    return isAdmin ? "" : (user?.editorId ?? "");
  });
  // Creating past office close? Default the due date to tomorrow — work
  // started tonight isn't meant for today anymore.
  const [dueDate, setDueDate] = useState(() => {
    if (task?.due_date) return task.due_date;
    const now = new Date();
    return now >= officeCloseToday(now) ? ymd(addDays(now, 1)) : today();
  });
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "medium");
  const [recurrence, setRecurrence] = useState<"none" | "daily" | "weekly">(task?.recurrence ?? "none");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [taskType, setTaskType] = useState<TaskType>(task?.task_type ?? "general");
  const [contentFormatId, setContentFormatId] = useState(task?.content_format_id ?? "");
  const { contentFormats, refetch: refetchFormats } = useContentFormats();
  const [addingFormat, setAddingFormat] = useState(false);
  const [newFormatName, setNewFormatName] = useState("");
  const [savingFormat, setSavingFormat] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Self-assigning (creating for yourself, or reassigning to yourself) accepts
  // immediately with no separate approval step — so unlike an explicit Accept,
  // there's no "before" moment to ask about office hours or daily workload.
  // Both checks run right after the save instead, using the server's resolved
  // budget/start time, and offer the same choices the explicit Accept flow does.
  const [scheduleConflict, setScheduleConflict] = useState<{ taskId: string; closeIn: string; alreadyClosed: boolean } | null>(null);
  const [workloadConflict, setWorkloadConflict] = useState<{ task: Task; total: number; tier: 1 | 2 } | null>(null);
  const [resolving, setResolving] = useState(false);

  // Admins can grow the taxonomy inline instead of hopping to a separate
  // settings screen — the new format is selected immediately.
  async function addFormat() {
    const name = newFormatName.trim();
    if (!name) return;
    setSavingFormat(true);
    try {
      const res = await api<{ contentFormat: ContentFormatDef }>("/content-formats", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await refetchFormats();
      setContentFormatId(res.contentFormat.id);
      setNewFormatName("");
      setAddingFormat(false);
    } catch (e2) {
      toast.error(e2 instanceof ApiError ? e2.message : "Could not add that format.");
    } finally {
      setSavingFormat(false);
    }
  }

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
      contentFormatId: contentFormatId || null,
    };
    if (!typeLocked) payload.taskType = taskType;
    try {
      const res = editing
        ? await api<{ task: Task }>(`/tasks/${task!.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await api<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify(payload) });
      toast.success(editing ? "Task updated." : "Task created.");
      if (user) noteTaskSeen(user.id, res.task.id);
      setSaving(false);
      await afterSave(res.task);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Could not save task.");
      setSaving(false);
    }
  }

  // Just self-accepted with a running clock — run the same two checks the
  // explicit Accept flow runs up front, just after the fact: first whether
  // this overloads the day, then whether its clock runs past office close.
  async function afterSave(saved: Task) {
    if (saved.accepted && saved.editor_id && saved.due_date && saved.budget_hours != null) {
      try {
        const { tasks: siblings } = await api<{ tasks: Task[] }>(
          `/tasks?editorId=${saved.editor_id}&dueBefore=${saved.due_date}&dueAfter=${saved.due_date}`,
        );
        const total = siblings
          .filter((x) => x.id !== saved.id && x.accepted && x.status !== "done" && x.budget_hours != null)
          .reduce((n, x) => n + Number(x.budget_hours), 0) + Number(saved.budget_hours);
        const tier = classifyWorkload(total);
        if (tier === 1 || tier === 2) {
          setWorkloadConflict({ task: saved, total, tier });
          return;
        }
      } catch {
        // Best-effort — a failed workload check shouldn't block the save.
      }
    }
    checkScheduleConflict(saved);
  }

  function checkScheduleConflict(saved: Task) {
    const startMs = saved.budget_started_at ? new Date(saved.budget_started_at).getTime() : null;
    if (saved.accepted && saved.budget_hours != null && startMs != null && startMs <= Date.now()) {
      const close = officeCloseToday(new Date(startMs));
      const alreadyClosed = startMs >= close.getTime();
      const wouldEnd = startMs + saved.budget_hours * 3_600_000;
      if (alreadyClosed || wouldEnd > close.getTime()) {
        const mins = alreadyClosed ? 0 : Math.max(0, Math.round((close.getTime() - startMs) / 60_000));
        setScheduleConflict({ taskId: saved.id, closeIn: `${Math.floor(mins / 60)}h ${mins % 60}m`, alreadyClosed });
        return;
      }
    }
    onSaved();
  }

  async function resolveWorkload(keep: boolean) {
    if (!workloadConflict) return;
    const saved = workloadConflict.task;
    setWorkloadConflict(null);
    if (!keep) {
      try {
        await api(`/tasks/${saved.id}`, { method: "PATCH", body: JSON.stringify({ editorId: null }) });
        toast.success("Unassigned — it's back in the pool.");
      } catch (e2) {
        toast.error(e2 instanceof ApiError ? e2.message : "Could not unassign.");
      }
      onSaved();
      return;
    }
    checkScheduleConflict(saved);
  }

  async function resolveConflict(reschedule: boolean) {
    if (!scheduleConflict) return;
    if (reschedule) {
      setResolving(true);
      try {
        await api(`/tasks/${scheduleConflict.taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ startAt: nineAmTomorrow(new Date()).toISOString() }),
        });
        toast.success("Deferred to 9 AM tomorrow.");
      } catch (e2) {
        toast.error(e2 instanceof ApiError ? e2.message : "Could not reschedule.");
      } finally {
        setResolving(false);
      }
    }
    setScheduleConflict(null);
    onSaved();
  }

  return (
    <>
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
            {isAdmin ? (
              <select className="t" value={editorId} onChange={(e) => setEditorId(e.target.value)}>
                <option value="">Unassigned</option>
                {editors.map((ed) => (
                  <option key={ed.id} value={ed.id}>{ed.name}</option>
                ))}
              </select>
            ) : (
              <div className="t" style={{ display: "flex", alignItems: "center", color: "var(--muted)" }} title="Only admins can assign tasks to a team member.">
                {editors.find((ed) => ed.id === editorId)?.name ?? "Unassigned"}
              </div>
            )}
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
              </select>
            )}
          </div>
        </div>
        <div className="field">
          <label className="f">Content format</label>
          <div className="formatpills">
            <button
              type="button"
              className={"formatpill" + (contentFormatId === "" ? " on" : "")}
              onClick={() => setContentFormatId("")}
            >
              None
            </button>
            {(contentFormats ?? []).map((f) => (
              <button
                type="button"
                key={f.id}
                className={"formatpill" + (contentFormatId === f.id ? " on" : "")}
                onClick={() => setContentFormatId(f.id)}
              >
                {f.icon} {f.name}
              </button>
            ))}
            {addingFormat ? (
              <span className="formatpill-add">
                <input
                  className="t"
                  autoFocus
                  placeholder="New format name"
                  value={newFormatName}
                  onChange={(e) => setNewFormatName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFormat(); } if (e.key === "Escape") setAddingFormat(false); }}
                />
                <button type="button" className="btn btn-sm btn-primary" disabled={savingFormat || !newFormatName.trim()} onClick={addFormat}>
                  {savingFormat ? "…" : "Add"}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => { setAddingFormat(false); setNewFormatName(""); }}>✕</button>
              </span>
            ) : (
              <button type="button" className="formatpill formatpill-new" onClick={() => setAddingFormat(true)}>
                ＋ New format
              </button>
            )}
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
            <label className="f">Time allotted</label>
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
    {scheduleConflict && (
      <div className="modal-bg show" onClick={() => resolveConflict(false)}>
        <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
          <div className="mhead">
            <span style={{ fontSize: 18 }}>⏰</span>
            <h3>{scheduleConflict.alreadyClosed ? "Office hours have ended for today" : "This runs past office hours"}</h3>
            <button className="x" onClick={() => resolveConflict(false)}>×</button>
          </div>
          <div className="mbody">
            <p style={{ margin: "0 0 4px", fontSize: 13.5, lineHeight: 1.6 }}>
              {scheduleConflict.alreadyClosed ? (
                <>Its timer already started, and office hours closed for today (6:00 PM) — the whole thing would run outside office hours.</>
              ) : (
                <>Its timer already started, but office hours close in <b>{scheduleConflict.closeIn}</b> (6:00 PM) — it'll finish outside office hours.</>
              )}
            </p>
          </div>
          <div className="mfoot">
            <button type="button" className="btn" disabled={resolving} onClick={() => resolveConflict(true)}>
              {resolving ? "…" : "Start 9 AM tomorrow"}
            </button>
            <button type="button" className="btn btn-primary" disabled={resolving} onClick={() => resolveConflict(false)}>
              Keep as started
            </button>
          </div>
        </div>
      </div>
    )}
    {workloadConflict && (
      <div className="modal-bg show" onClick={() => resolveWorkload(false)}>
        <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
          <div className="mhead">
            <span style={{ fontSize: 18 }}>{workloadConflict.tier === 2 ? "🔴" : "⚠️"}</span>
            <h3>{workloadConflict.tier === 2 ? "That's a full day already" : "Heavy day ahead"}</h3>
            <button className="x" onClick={() => resolveWorkload(false)}>×</button>
          </div>
          <div className="mbody">
            <p style={{ margin: "0 0 4px", fontSize: 13.5, lineHeight: 1.6 }}>
              With <b>{workloadConflict.task.title}</b>, this now adds up to about{" "}
              <b>{fmtHours(workloadConflict.total)}h</b> due <b>{workloadConflict.task.due_date}</b> —{" "}
              {workloadConflict.tier === 2
                ? "a full office day (9h) or more, spread across several tasks. It likely can't all get finished today."
                : "more than half the office day already spoken for across other tasks."}
            </p>
          </div>
          <div className="mfoot">
            <button type="button" className="btn" onClick={() => resolveWorkload(false)}>Unassign me</button>
            <button type="button" className="btn btn-primary" onClick={() => resolveWorkload(true)}>Keep it</button>
          </div>
        </div>
      </div>
    )}
    </>
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
