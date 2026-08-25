import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, useDraggable, useDroppable, closestCorners,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useContentFormats } from "@/lib/use-content-formats";
import { noteTaskSeen } from "@/lib/use-task-notify";
import { breakOffsetMs, isOverBudget } from "@/lib/task-timing";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { usePosts } from "@/lib/use-posts";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import { toast } from "sonner";
import type { Task, TaskStatus, TaskPriority, TaskType, TaskMeta, TaskReviewLogEntry, ContentFormatDef, Editor, Subtask, TaskComment } from "@/lib/types";

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
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];
const PRI_LABEL: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High" };

const TYPE_LABEL: Record<TaskType, string> = {
  content: "Content",
  short_task: "Short task",
  general: "General",
  social: "Social Media",
  ad: "Paid Ad",
};
const TYPE_ICON: Record<TaskType, string> = { content: "📄", short_task: "⚡", general: "🗒️", social: "📱", ad: "📢" };
// Task types selectable in the Add/Edit Task modal — "content" is reserved
// for auto-created (post-linked) tasks, not offered here.
const SELECTABLE_TASK_TYPES: TaskType[] = ["general", "short_task", "social", "ad"];
// Coarse 3-way grouping for color-coding (calendar view, etc.) — mirrors the
// "Normal / Social / Ad" split already used in the toolbar summary stats.
// content/short_task/general all read as "Normal" work at a glance.
type TaskTypeBucket = "normal" | "social" | "ad";
function taskTypeBucket(t: Task): TaskTypeBucket {
  return t.task_type === "social" ? "social" : t.task_type === "ad" ? "ad" : "normal";
}

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
    return { scheduled: true, over: false, paused: false, label: `Starts ${new Date(startMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` };
  }
  const deadlineMs = startMs + t.budget_hours * 3_600_000 + breakOffsetMs(t, nowMs);
  const remainingMs = deadlineMs - nowMs;
  const over = remainingMs < 0;
  // On break right now, and not already over even accounting for the break
  // offset — the clock reads as paused (yellow) rather than running (green).
  const paused = !over && !!t.editor_break_started_at;
  const absMs = Math.abs(remainingMs);
  const h = Math.floor(absMs / 3_600_000);
  const m = Math.floor((absMs % 3_600_000) / 60_000);
  return { scheduled: false, over, paused, label: h > 0 ? `${h}h ${m}m` : `${m}m` };
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
  const { active, isAdmin } = useWorkspaces();
  const role = active?.role;
  // Viewers are read-only (the backend already 403s their writes); hide the
  // status-move controls from them so the affordance matches the permission.
  const canWrite = active?.role !== "viewer";
  const isOwner = (t: Task) => !!user?.editorId && t.editor_id === user.editorId;
  // Review is a checkpoint, not just another column: the assignee moves a
  // task through todo -> in_progress -> review on their own; only an admin
  // can resolve a review — approve it into done, or send it back to
  // in_progress for rework. The backend enforces this too.
  function canTransition(t: Task, target: TaskStatus): boolean {
    if (!canWrite || target === t.status) return false;
    if (t.status === "review") return isAdmin && (target === "done" || target === "in_progress");
    if (target === "done") return false; // must go through review
    return isOwner(t);
  }
  const canMoveStatus = (t: Task) => canWrite && (t.status === "review" ? isAdmin : isOwner(t));

  const [filterEditor, setFilterEditor] = useState("");
  const [filterType, setFilterType] = useState<TaskType | "">("");
  const [filterFormat, setFilterFormat] = useState("");
  const [dueTab, setDueTab] = useState<DueTab>("all");
  // Global lookup — matches a task's TID/SID/AdID exactly or its title
  // loosely, so "TID-00042" or "diabetes reel" both find their way in.
  const [search, setSearch] = useState("");
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
  const [reworkNotePrompt, setReworkNotePrompt] = useState<{ task: Task } | null>(null);

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
    () => {
      const q = search.trim().toLowerCase();
      return effective.filter((t) => {
        if (scope === "mine" && t.editor_id !== user?.editorId) return false;
        if (filterEditor && t.editor_id !== filterEditor) return false;
        if (filterType && t.task_type !== filterType) return false;
        if (filterFormat && t.content_format_id !== filterFormat) return false;
        if (!matchesDueTab(t, dueTab, now)) return false;
        if (q) {
          const hit =
            t.title.toLowerCase().includes(q) ||
            t.tid?.toLowerCase().includes(q) ||
            t.sid?.toLowerCase().includes(q) ||
            t.ad_id?.toLowerCase().includes(q);
          if (!hit) return false;
        }
        return true;
      });
    },
    [effective, scope, user?.editorId, filterEditor, filterType, filterFormat, dueTab, now, search],
  );
  const byStatus = (s: TaskStatus) => filtered.filter((t) => t.status === s);

  // Toolbar summary strip — counts across every task in the org (not just
  // whatever's currently filtered), so it reads as a stable at-a-glance total.
  const taskCounts = useMemo(() => {
    const all = tasks ?? [];
    let social = 0, ad = 0, pendingOverdue = 0;
    for (const t of all) {
      if (t.task_type === "social") social++;
      if (t.task_type === "ad") ad++;
      const overdue = t.status !== "done" && !!t.due_date && t.due_date < today();
      if (overdue || isOverBudget(t, nowMs)) pendingOverdue++;
    }
    return { total: all.length, social, ad, pendingOverdue };
  }, [tasks, nowMs]);

  // Both the ←/→ links and drag-and-drop call this — one PATCH path, so the
  // backend side effects (completion timestamp, recurring spawn, activity log)
  // are identical however the card is moved. Optimistic: the card moves now;
  // on failure it reverts to its original column and an error is surfaced.
  // Sending a task back from review needs a note first — that's a separate
  // prompt (see sendBackPrompt below) rather than an instant move.
  async function move(t: Task, status: TaskStatus, reviewNote?: string) {
    if (t.status === status) return;
    if (!canTransition(t, status)) {
      toast.error(
        t.status === "review"
          ? "Only an admin can approve or send back a task in review."
          : status === "done"
            ? "Move it to Review first."
            : "Only the person this task is assigned to can move it.",
      );
      return;
    }
    if (t.status === "review" && status === "in_progress" && reviewNote === undefined) {
      setSendBackPrompt({ task: t });
      setSendBackNote("");
      return;
    }
    setPending((p) => ({ ...p, [t.id]: status }));
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status, ...(reviewNote ? { reviewNote } : {}) }) });
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update task.");
    } finally {
      setPending((p) => { const n = { ...p }; delete n[t.id]; return n; });
    }
  }

  const [sendBackPrompt, setSendBackPrompt] = useState<{ task: Task } | null>(null);
  const [sendBackNote, setSendBackNote] = useState("");
  const [sendingBackBusy, setSendingBackBusy] = useState(false);
  async function confirmSendBack() {
    if (!sendBackPrompt) return;
    const note = sendBackNote.trim();
    if (!note) { toast.error("Add a note explaining what needs fixing."); return; }
    setSendingBackBusy(true);
    try {
      await move(sendBackPrompt.task, "in_progress", note);
      setSendBackPrompt(null);
    } finally {
      setSendingBackBusy(false);
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

  // Accepting a reworked task shows the admin's note first — the whole point
  // of the re-accept gate is that the assignee actually sees what needs
  // fixing before the clock resumes, not that it just silently continues.
  function handleAccept(t: Task) {
    if (t.pending_note) {
      setReworkNotePrompt({ task: t });
      return;
    }
    proceedAccept(t);
  }

  // Then the usual checks, in sequence, either of which can pause for a
  // confirmation: first whether it overloads the day, then whether its clock
  // would run past office close (including after close has already passed).
  function proceedAccept(t: Task) {
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
      {/* Always visible, never competes for space with the filters below —
          search and creating a task are the two things you reach for most. */}
      <div className="toolbar-primary">
        <div className="search" style={{ maxWidth: 420 }}>
          🔎
          <input
            placeholder="Search by TID / SID / AdID / title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="toolbar-summary">
          <span><b>{taskCounts.total}</b> total</span>
          <span className="dot-sep">·</span>
          <span><b>{taskCounts.social}</b> social</span>
          <span className="dot-sep">·</span>
          <span><b>{taskCounts.ad}</b> ad</span>
          <span className="dot-sep">·</span>
          <span className={taskCounts.pendingOverdue > 0 ? "toolbar-summary-alert" : undefined}><b>{taskCounts.pendingOverdue}</b> pending/overdue</span>
        </div>
        <button
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          ＋ Add Task
        </button>
      </div>

      {/* Filters — each group is its own pill/tab cluster and wraps onto a
          new line if it doesn't fit, instead of forcing a horizontal scrollbar. */}
      <div className="toolbar-filters">
        <div className="seg">
          <button className={scope === "mine" ? "on" : ""} onClick={() => setScopeAndPersist("mine")}>🙋 My Tasks</button>
          <button className={scope === "team" ? "on" : ""} onClick={() => setScopeAndPersist("team")}>👥 Team</button>
        </div>
        <div className="seg tabseg">
          {DUE_TABS.map((d) => (
            <button key={d.key} className={dueTab === d.key ? "on" : ""} onClick={() => setDueTab(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
        <select
          className="t"
          style={{ maxWidth: 160 }}
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
          style={{ maxWidth: 145 }}
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
          style={{ maxWidth: 135 }}
          value={filterFormat}
          onChange={(e) => setFilterFormat(e.target.value)}
        >
          <option value="">All formats</option>
          {(contentFormats ?? []).map((f) => (
            <option key={f.id} value={f.id}>{f.icon} {f.name}</option>
          ))}
        </select>
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>🗂️ Board</button>
          <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")}>📅 Calendar</button>
        </div>
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
            const allItems = byStatus(col.key);
            // Done resets daily on the board — only today's completions show
            // here, so it never grows into an endless scroll. Anything
            // finished on an earlier day is still there, just not on the
            // board — the Calendar shows every day's completions by the day
            // they were actually finished (see TaskCalendar below).
            const isDone = col.key === "done";
            const items = isDone ? allItems.filter((t) => t.completed_at && ymd(new Date(t.completed_at)) === today()) : allItems;
            const olderDoneCount = isDone ? allItems.length - items.length : 0;
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
                        <span className="task-kind">
                          {TYPE_ICON[t.task_type]} {TYPE_LABEL[t.task_type]}
                          {t.content_format_name && <> · {t.content_format_icon} {t.content_format_name}</>}
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
                      {t.pending_note && (
                        <div className="task-rework-note" title={t.pending_note}>
                          📝 Rework: {t.pending_note}
                        </div>
                      )}
                      {(t.tid || t.sid || t.ad_id || t.revision > 1) && (
                        <div className="task-ids">
                          {t.tid && <span>{t.tid}</span>}
                          {t.sid && <><span className="dot-sep">·</span><span>{t.sid}</span></>}
                          {t.ad_id && <><span className="dot-sep">·</span><span>{t.ad_id}</span></>}
                          {t.revision > 1 && <><span className="dot-sep">·</span><span title="Sent back for rework" style={{ color: "var(--amber)" }}>Rev {t.revision}</span></>}
                        </div>
                      )}
                      <div className="task-meta">
                        {/* Every card in "My Tasks" is already yours — showing your own name on each one is noise */}
                        {!(scope === "mine" && t.editor_id === user?.editorId) && (
                          <Assignee name={t.editor_name} image={t.editor_image} />
                        )}
                        {t.due_date && (
                          <span className={"task-due" + (overdue ? " over" : "")}>
                            📅 {t.due_date}
                            {overdue && ` · ${daysOverdue(t.due_date!)}d overdue`}
                          </span>
                        )}
                      </div>
                      {(() => {
                        const acceptSlot = t.editor_id && !t.accepted ? (
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
                          const cls = b.over ? " over" : b.paused ? " paused" : b.scheduled ? "" : " running";
                          const title = b.scheduled
                            ? "Timer hasn't started yet"
                            : b.over
                              ? "Ran past its allotted time — needs follow-up"
                              : b.paused
                                ? "Paused — the assignee is on a break"
                                : "Time remaining";
                          return (
                            <span className={"task-timer" + cls} title={title}>
                              {b.scheduled ? `⏱ ${b.label}` : b.over ? `⚠ Pending — ${b.label} over` : b.paused ? `⏸ ${b.label} left` : `⏱ ${b.label} left`}
                            </span>
                          );
                        })();
                        const subtaskSlot = t.subtask_total > 0 && (
                          <span className={"task-check" + (t.subtask_done === t.subtask_total ? " full" : "")}>
                            ☑ {t.subtask_done}/{t.subtask_total}
                          </span>
                        );
                        if (!acceptSlot && !subtaskSlot) return null;
                        return (
                          <div className="task-status-row">
                            {acceptSlot}
                            {subtaskSlot}
                          </div>
                        );
                      })()}
                      {(() => {
                        const canPrev = ci > 0 && canTransition(t, COLUMNS[ci - 1].key);
                        const canNext = ci < COLUMNS.length - 1 && canTransition(t, COLUMNS[ci + 1].key);
                        if (!canPrev && !canNext) {
                          // In review but this isn't an admin's view — nothing
                          // to do here but wait.
                          return t.status === "review" ? (
                            <div className="task-actions">
                              <span className="hint" style={{ margin: 0 }}>⏳ Waiting on admin review</span>
                            </div>
                          ) : null;
                        }
                        return (
                          <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                            {canPrev && (
                              <button className="linkbtn" onClick={() => move(t, COLUMNS[ci - 1].key)}>
                                ← {COLUMNS[ci - 1].label}
                              </button>
                            )}
                            {canNext && (
                              <button className="linkbtn" onClick={() => move(t, COLUMNS[ci + 1].key)}>
                                {COLUMNS[ci + 1].label} →
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                  return canMoveStatus(t) ? (
                    <DraggableCard id={t.id} key={t.id}>{cardInner}</DraggableCard>
                  ) : cardInner;
                })}
                {items.length === 0 && <div className="task-empty">{isDone ? "Nothing finished yet today" : "Nothing here"}</div>}
                {isDone && olderDoneCount > 0 && (
                  <button type="button" className="task-show-more" onClick={() => setView("calendar")}>
                    {olderDoneCount} completed on earlier days — view Calendar →
                  </button>
                )}
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

      {reworkNotePrompt && (
        <div className="modal-bg show" onClick={() => setReworkNotePrompt(null)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="mhead">
              <span style={{ fontSize: 18 }}>📝</span>
              <h3>Rework requested</h3>
              <button className="x" onClick={() => setReworkNotePrompt(null)}>×</button>
            </div>
            <div className="mbody">
              <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6 }}>
                Before you continue on <b>{reworkNotePrompt.task.title}</b>, here's what the admin flagged:
              </p>
              <div style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 13.5,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}>
                {reworkNotePrompt.task.pending_note}
              </div>
              <p style={{ margin: "10px 0 0", fontSize: 12.5, opacity: 0.7 }}>
                Accepting resumes your timer from where it was paused — it won't reset to the full budget.
              </p>
            </div>
            <div className="mfoot">
              <button type="button" className="btn" onClick={() => setReworkNotePrompt(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const t = reworkNotePrompt.task;
                  setReworkNotePrompt(null);
                  proceedAccept(t);
                }}
              >
                Got it, continue
              </button>
            </div>
          </div>
        </div>
      )}
      {sendBackPrompt && (
        <div className="modal-bg show" onClick={() => setSendBackPrompt(null)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="mhead">
              <span style={{ fontSize: 18 }}>↩️</span>
              <h3>Send back for rework</h3>
              <button className="x" onClick={() => setSendBackPrompt(null)}>×</button>
            </div>
            <div className="mbody">
              <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6 }}>
                What does <b>{sendBackPrompt.task.editor_name}</b> need to fix on <b>{sendBackPrompt.task.title}</b> before resubmitting?
              </p>
              <textarea
                className="t"
                autoFocus
                placeholder="Explain what needs fixing…"
                value={sendBackNote}
                onChange={(e) => setSendBackNote(e.target.value)}
              />
            </div>
            <div className="mfoot">
              <button type="button" className="btn" onClick={() => setSendBackPrompt(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={sendingBackBusy || !sendBackNote.trim()} onClick={confirmSendBack}>
                {sendingBackBusy ? "Sending…" : "Send back"}
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
  const [meta, setMeta] = useState<TaskMeta>(task?.meta ?? {});
  // Required when an admin sends a task back from Review to In progress —
  // what the team needs to fix before resubmitting.
  const [reviewNote, setReviewNote] = useState("");
  const sendingBack = editing && task?.status === "review" && status === "in_progress";
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
    if (sendingBack && !reviewNote.trim()) { setErr("Add a note explaining what needs fixing."); return; }
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
    if (sendingBack) payload.reviewNote = reviewNote.trim();
    if (!typeLocked) {
      payload.taskType = taskType;
      if (taskType === "social" || taskType === "ad") payload.meta = meta;
    }
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
    <Modal onClose={onClose} title={editing ? "Edit Task" : "Add Task"} variant="drawer">
      {editing && task && (task.tid || task.sid || task.ad_id) && (
        <div className="task-ids" style={{ fontSize: 11.5, marginBottom: 14 }}>
          {task.tid && <span>{task.tid}</span>}
          {task.sid && <><span className="dot-sep">·</span><span>{task.sid}</span></>}
          {task.ad_id && <><span className="dot-sep">·</span><span>{task.ad_id}</span></>}
        </div>
      )}
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
                {SELECTABLE_TASK_TYPES.map((tt) => (
                  <option key={tt} value={tt}>{TYPE_ICON[tt]} {TYPE_LABEL[tt]}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        {taskType === "social" && !typeLocked && (
          <div className="grid g3">
            <div className="field">
              <label className="f">Platform</label>
              <input className="t" placeholder="e.g. Instagram" value={meta.platform ?? ""} onChange={(e) => setMeta((m) => ({ ...m, platform: e.target.value }))} />
            </div>
            <div className="field" style={{ gridColumn: "span 2" }}>
              <label className="f">Caption</label>
              <input className="t" placeholder="Post caption…" value={meta.caption ?? ""} onChange={(e) => setMeta((m) => ({ ...m, caption: e.target.value }))} />
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label className="f">Asset links</label>
              <input className="t" placeholder="Links to creative assets…" value={meta.assetLinks ?? ""} onChange={(e) => setMeta((m) => ({ ...m, assetLinks: e.target.value }))} />
            </div>
          </div>
        )}
        {taskType === "ad" && !typeLocked && (
          <div className="grid g3">
            <div className="field">
              <label className="f">Platform</label>
              <input className="t" placeholder="e.g. Meta Ads" value={meta.platform ?? ""} onChange={(e) => setMeta((m) => ({ ...m, platform: e.target.value }))} />
            </div>
            <div className="field">
              <label className="f">Ad spend</label>
              <input className="t" type="number" min="0" step="0.01" placeholder="0.00" value={meta.adSpend ?? ""} onChange={(e) => setMeta((m) => ({ ...m, adSpend: e.target.value ? Number(e.target.value) : undefined }))} />
            </div>
            <div className="field">
              <label className="f">Target URL</label>
              <input className="t" placeholder="https://…" value={meta.targetUrl ?? ""} onChange={(e) => setMeta((m) => ({ ...m, targetUrl: e.target.value }))} />
            </div>
          </div>
        )}
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
            {COLUMNS.map((c) => {
              // Same review-checkpoint rule the board enforces (and the
              // backend is the real gate for) — free choice while creating,
              // but editing an existing task only offers valid transitions.
              const selectable =
                !editing || !task || c.key === task.status
                  ? true
                  : task.status === "review"
                    ? isAdmin && (c.key === "done" || c.key === "in_progress")
                    : c.key !== "done" && !!user?.editorId && task.editor_id === user.editorId;
              return (
                <button
                  type="button"
                  key={c.key}
                  disabled={!selectable}
                  className={status === c.key ? "on" : ""}
                  onClick={() => selectable && setStatus(c.key)}
                  title={!selectable ? "Not available from here" : undefined}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {editing && task?.status === "review" && !isAdmin && (
            <div className="hint" style={{ marginTop: 6 }}>⏳ Waiting on admin review — only an admin can approve or send it back.</div>
          )}
        </div>
        {sendingBack && (
          <div className="field">
            <label className="f">What needs fixing? <span className="req">*</span></label>
            <textarea
              className="t"
              placeholder="Explain what the team should fix before resubmitting…"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
          </div>
        )}
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
        {editing && task && <ReviewHistory taskId={task.id} />}
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

// This task's review decisions (sent back for rework, or approved) — newest
// first. Self-hides when there's no history yet, so a task that's never been
// through review doesn't grow an empty section.
function ReviewHistory({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<TaskReviewLogEntry[] | null>(null);

  useEffect(() => {
    let cancel = false;
    api<{ reviews: TaskReviewLogEntry[] }>(`/tasks/${taskId}/reviews`)
      .then((d) => { if (!cancel) setItems(d.reviews); })
      .catch(() => { if (!cancel) setItems([]); });
    return () => { cancel = true; };
  }, [taskId]);

  if (!items || items.length === 0) return null;

  return (
    <div className="field">
      <label className="f">Review history</label>
      <div className="cmt-list">
        {items.map((r) => (
          <div className="cmt" key={r.id}>
            <span className="cmt-ava">{r.action === "approved" ? "✅" : "↩️"}</span>
            <div className="cmt-body">
              <div className="cmt-head">
                <b>{r.actor_name ?? "Someone"}</b>
                <span>{r.action === "approved" ? "approved" : "sent back"} · Rev {r.revision}</span>
                <span className="cmt-time" style={{ marginLeft: "auto" }}>{relTime(r.created_at)}</span>
              </div>
              {r.note && <div className="cmt-text">{r.note}</div>}
            </div>
          </div>
        ))}
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

// A done task sits on the day it was actually finished, not the day it was
// due; everything still in progress stays keyed by its due date. Shared by
// the month grid, the week grid, and the day timeline below.
function bucketTasksByDay(tasks: Task[]) {
  const byDay: Record<string, Task[]> = {};
  for (const t of tasks) {
    const key = t.status === "done" && t.completed_at ? ymd(new Date(t.completed_at)) : t.due_date;
    if (key) (byDay[key] ||= []).push(t);
  }
  return byDay;
}

function TaskCalendar({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  const [calMode, setCalMode] = useState<"month" | "week">("month");
  const [offset, setOffset] = useState(0); // month nav, month mode only
  const [weekOffset, setWeekOffset] = useState(0); // week nav, week mode only
  const [dayView, setDayView] = useState<Date | null>(null);
  const now = new Date();
  const todayS = ymd(now);

  const byDay = useMemo(() => bucketTasksByDay(tasks), [tasks]);
  const noDate = tasks.filter((t) => !(t.status === "done" ? t.completed_at : t.due_date)).length;

  const goPrev = () => (calMode === "month" ? setOffset((o) => o - 1) : setWeekOffset((o) => o - 1));
  const goNext = () => (calMode === "month" ? setOffset((o) => o + 1) : setWeekOffset((o) => o + 1));
  const goToday = () => { setOffset(0); setWeekOffset(0); };
  const isToday = calMode === "month" ? offset === 0 : weekOffset === 0;

  // Month grid.
  const view = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = view.getFullYear();
  const month = view.getMonth();
  const monthName = view.toLocaleString("default", { month: "long", year: "numeric" });
  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthCells: (Date | null)[] = [];
  for (let i = 0; i < startDow; i++) monthCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) monthCells.push(new Date(year, month, d));
  while (monthCells.length % 7 !== 0) monthCells.push(null);

  // Week grid — Sunday to Saturday, like the iOS Calendar week strip.
  const weekBase = addDays(now, weekOffset * 7);
  const weekStart = addDays(weekBase, -weekBase.getDay());
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = weekDays[6];
  const weekLabel = weekStart.getMonth() === weekEnd.getMonth()
    ? `${weekStart.toLocaleString("default", { month: "long" })} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
    : `${weekStart.toLocaleString("default", { month: "short" })} ${weekStart.getDate()} – ${weekEnd.toLocaleString("default", { month: "short" })} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;

  function renderCell(d: Date | null, i: number, maxChips: number) {
    if (d === null) return <div key={i} className="cal-cell empty" />;
    const key = ymd(d);
    const items = byDay[key] ?? [];
    return (
      <div
        key={i}
        className={"cal-cell" + (key === todayS ? " today" : "")}
        onClick={() => setDayView(d)}
        title="View the day's timeline"
      >
        <div className="cal-day">{d.getDate()}</div>
        <div className="cal-items">
          {items.slice(0, maxChips).map((t) => (
            <button
              key={t.id}
              className={"cal-task " + taskTypeBucket(t) + " status-" + t.status}
              onClick={(e) => { e.stopPropagation(); onOpen(t); }}
              title={`${TYPE_LABEL[t.task_type]} · ${t.title}`}
            >
              {t.title}
            </button>
          ))}
          {items.length > maxChips && <div className="cal-more">+{items.length - maxChips} more</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="card pad">
      <div className="cal-head">
        <button className="btn icon" onClick={goPrev} aria-label={calMode === "month" ? "Previous month" : "Previous week"}>‹</button>
        <h3 className="cal-title">{calMode === "month" ? monthName : weekLabel}</h3>
        <button className="btn icon" onClick={goNext} aria-label={calMode === "month" ? "Next month" : "Next week"}>›</button>
        {!isToday && <button className="linkbtn" onClick={goToday}>Today</button>}
        <div className="cal-mode-seg">
          <button className={calMode === "month" ? "on" : ""} onClick={() => setCalMode("month")}>Month</button>
          <button className={calMode === "week" ? "on" : ""} onClick={() => setCalMode("week")}>Week</button>
        </div>
        <div className="spacer" />
        <div className="cal-legend">
          <span className="cal-legend-item"><span className="cal-legend-dot normal" />Normal</span>
          <span className="cal-legend-item"><span className="cal-legend-dot social" />Social</span>
          <span className="cal-legend-item"><span className="cal-legend-dot ad" />Ad</span>
        </div>
        {noDate > 0 && <span className="hint" style={{ margin: 0 }}>{noDate} without a due date</span>}
      </div>
      <div className="cal-grid cal-dow">{WEEKDAYS.map((w) => <div key={w} className="cal-dowc">{w}</div>)}</div>
      <div className={"cal-grid" + (calMode === "week" ? " week" : "")}>
        {calMode === "month"
          ? monthCells.map((d, i) => renderCell(d, i, 3))
          : weekDays.map((d, i) => renderCell(d, i, 6))}
      </div>
      {dayView && (
        <Modal onClose={() => setDayView(null)} variant="drawer" title={dayView.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}>
          <DayTimeline
            date={dayView}
            tasks={byDay[ymd(dayView)] ?? []}
            onOpen={onOpen}
            onPrev={() => setDayView((d) => addDays(d!, -1))}
            onNext={() => setDayView((d) => addDays(d!, 1))}
            onToday={() => setDayView(new Date())}
          />
        </Modal>
      )}
    </div>
  );
}

// A task's clock-time block on the day timeline — only resolvable once it
// has actually started (budget_started_at set) and has a duration
// (budget_hours). Anything else (not yet accepted, no time budget) has no
// time of day to place, and shows in the all-day strip instead.
function timeBlockFor(t: Task): { startMin: number; durMin: number } | null {
  if (t.budget_hours == null || !t.budget_started_at) return null;
  const start = new Date(t.budget_started_at);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const durMin = Math.max(20, Math.round(Number(t.budget_hours) * 60));
  return { startMin, durMin };
}

// Greedy interval-column packing so overlapping tasks sit side by side
// instead of stacking on top of each other, iOS-Calendar style.
function layoutTimedEvents(items: { task: Task; startMin: number; durMin: number }[]) {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin);
  const colEnds: number[] = [];
  const placed = sorted.map((e) => {
    let col = colEnds.findIndex((end) => end <= e.startMin);
    if (col === -1) { col = colEnds.length; colEnds.push(e.startMin + e.durMin); }
    else colEnds[col] = e.startMin + e.durMin;
    return { ...e, col };
  });
  const totalCols = colEnds.length || 1;
  return placed.map((e) => ({ ...e, totalCols }));
}

function fmtClock(min: number) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: m ? "2-digit" : undefined });
}

const ROW_H = 52; // px per hour

// iPhone-style day view: an all-day strip for tasks with no time-of-day, and
// an hour-by-hour timeline below with each task drawn as a block positioned
// and sized by when its clock started and how long its budget runs — exactly
// the "see the time duration of it" view from a day cell.
function DayTimeline({
  date,
  tasks,
  onOpen,
  onPrev,
  onNext,
  onToday,
}: {
  date: Date;
  tasks: Task[];
  onOpen: (t: Task) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const allDay = tasks.filter((t) => !timeBlockFor(t));
  const timed = layoutTimedEvents(
    tasks.flatMap((t) => {
      const b = timeBlockFor(t);
      return b ? [{ task: t, ...b }] : [];
    }),
  );
  const isToday = ymd(date) === ymd(new Date());
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Open scrolled to mid-morning (or the current time, if today) instead of
  // midnight — matches where the day's actual work tends to sit.
  useEffect(() => {
    const anchorMin = isToday ? Math.max(0, nowMin - 90) : 7 * 60;
    scrollRef.current?.scrollTo({ top: (anchorMin / 60) * ROW_H });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ymd(date)]);

  return (
    <div className="dayview">
      <div className="dayview-nav">
        <button className="btn icon" onClick={onPrev} aria-label="Previous day">‹</button>
        <button className="btn icon" onClick={onNext} aria-label="Next day">›</button>
        {!isToday && <button className="linkbtn" onClick={onToday}>Today</button>}
      </div>
      {allDay.length > 0 && (
        <div className="dayview-allday">
          {allDay.map((t) => (
            <button
              key={t.id}
              className={"cal-task " + taskTypeBucket(t) + " status-" + t.status}
              onClick={() => onOpen(t)}
              title={`${TYPE_LABEL[t.task_type]} · ${t.title}`}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
      <div className="dayview-timeline" ref={scrollRef}>
        <div className="dayview-hours">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="dayview-hourrow" style={{ height: ROW_H }}>
              <span className="dayview-hourlabel">{fmtClock(h * 60)}</span>
            </div>
          ))}
        </div>
        <div className="dayview-track" style={{ height: 24 * ROW_H }}>
          {isToday && (
            <div className="dayview-now" style={{ top: (nowMin / 60) * ROW_H }}>
              <span className="dayview-now-dot" />
            </div>
          )}
          {timed.map(({ task: t, startMin, durMin, col, totalCols }) => (
            <button
              key={t.id}
              className={"dayview-block " + taskTypeBucket(t) + " status-" + t.status}
              style={{
                top: (startMin / 60) * ROW_H,
                height: Math.max(20, (durMin / 60) * ROW_H),
                left: `${(col / totalCols) * 100}%`,
                width: `${100 / totalCols}%`,
              }}
              onClick={() => onOpen(t)}
              title={`${TYPE_LABEL[t.task_type]} · ${t.title} · ${fmtClock(startMin)}–${fmtClock(startMin + durMin)}`}
            >
              <span className="dayview-block-title">{t.title}</span>
              <span className="dayview-block-time">{fmtClock(startMin)} – {fmtClock(startMin + durMin)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
