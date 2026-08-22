import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, useDraggable, useDroppable, closestCorners,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { api, ApiError } from "@/lib/api";
import { toast } from "sonner";
import type { Task, TaskStatus, TaskPriority, TaskAttachment, Editor, Subtask, TaskComment } from "@/lib/types";

function relTime(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "review", label: "Review" },
  { key: "done", label: "Completed" },
];
const PRI_LABEL: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High" };

// Task content type — a flexible, task-level deliverable tag (separate from the
// post taxonomy). The UI drives the list; the backend stores it as free text.
const CONTENT_TYPES: { value: string; label: string }[] = [
  { value: "reel", label: "Reel" },
  { value: "ad_video", label: "Ad Video" },
  { value: "carousel", label: "Carousel" },
  { value: "thumbnail", label: "Thumbnail" },
  { value: "youtube_video", label: "YouTube Video" },
];
const CONTENT_LABEL = (v: string | null) => CONTENT_TYPES.find((c) => c.value === v)?.label ?? null;

const PLATFORM_META: Record<string, { icon: string; label: string }> = {
  instagram: { icon: "📸", label: "Instagram" },
  facebook: { icon: "👍", label: "Facebook" },
  youtube: { icon: "▶️", label: "YouTube" },
};
const ALL_PLATFORMS = ["instagram", "facebook", "youtube"];

const SORTS: { value: string; label: string }[] = [
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Newest" },
  { value: "title", label: "Title" },
];
const PRI_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const taskCode = (serial: number) => `TASK-${serial}`;

function today() {
  // Local calendar date as YYYY-MM-DD (Date.now avoided elsewhere but fine here).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const { active, workspaces } = useWorkspaces();
  // Viewers are read-only (the backend already 403s their writes); hide the
  // status-move controls from them so the affordance matches the permission.
  const canWrite = active?.role !== "viewer";
  const [filterEditor, setFilterEditor] = useState("");
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
  const [view, setView] = useState<"board" | "list" | "calendar">("board");
  // Right-side detail panel: hold the id, derive the live task so inline edits +
  // refetch keep the panel fresh. `creating` opens the panel in create mode.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("due");
  const [quickAddCol, setQuickAddCol] = useState<TaskStatus | null>(null);
  const [quickAddText, setQuickAddText] = useState("");
  const openTask = (t: Task) => { setCreating(false); setSelectedId(t.id); };
  // "New Task" opens the full task-creation card, centered.
  const startNewTask = () => { setSelectedId(null); setCreating(true); };
  const selectedTask = (tasks ?? []).find((t) => t.id === selectedId) ?? null;

  async function quickAdd(status: TaskStatus) {
    const title = quickAddText.trim();
    if (!title) { setQuickAddCol(null); return; }
    try {
      await api("/tasks", { method: "POST", body: JSON.stringify({ title, status }) });
      setQuickAddText("");
      await refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not add task.");
    }
  }

  // Apply any in-flight optimistic status before filtering, so the board (and
  // the per-column counts derived from it) reflect a drop immediately.
  const effective = useMemo(
    () => (tasks ?? []).map((t) => (pending[t.id] ? { ...t, status: pending[t.id] } : t)),
    [tasks, pending],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = effective.filter((t) =>
      (!filterEditor || t.editor_id === filterEditor) &&
      (!q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)),
    );
    const cmp: Record<string, (a: Task, b: Task) => number> = {
      due: (a, b) => (a.due_date ?? "9999-99").localeCompare(b.due_date ?? "9999-99"),
      priority: (a, b) => (PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"),
      created: (a, b) => b.created_at.localeCompare(a.created_at),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...list].sort(cmp[sortBy] ?? cmp.due);
  }, [effective, filterEditor, query, sortBy]);
  const byStatus = (s: TaskStatus) => filtered.filter((t) => t.status === s);

  // Both the ←/→ links and drag-and-drop call this — one PATCH path, so the
  // backend side effects (completion timestamp, recurring spawn, activity log)
  // are identical however the card is moved. Optimistic: the card moves now;
  // on failure it reverts to its original column and an error is surfaced.
  async function move(t: Task, status: TaskStatus) {
    if (t.status === status) return;
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

  return (
    <section className="screen">
      <div className="toolbar">
        <div className="seg" style={{ margin: 0 }}>
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>🗂️ Board</button>
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>☰ List</button>
          <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")}>📅 Calendar</button>
        </div>
        <div className="search" style={{ maxWidth: 260 }}>
          <span aria-hidden>🔎</span>
          <input placeholder="Search tasks…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="t" style={{ maxWidth: 200 }} value={filterEditor} onChange={(e) => setFilterEditor(e.target.value)}>
          <option value="">All team members</option>
          {(editors ?? []).map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
        </select>
        <select className="t" style={{ maxWidth: 150 }} value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort tasks">
          {SORTS.map((s) => (<option key={s.value} value={s.value}>↕ {s.label}</option>))}
        </select>
        <div className="spacer" />
        {canWrite && (
          <button className="btn btn-primary" onClick={startNewTask}>
            ＋ New Task
          </button>
        )}
      </div>

      {tasks === null ? (
        <div className="hint">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13.5 }}>
          No tasks yet. Click <b>＋ Add Task</b> to assign your first daily task to a team member.
        </div>
      ) : view === "list" ? (
        <TaskList tasks={filtered} onOpen={openTask} />
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
                  {canWrite && (
                    <button className="task-coladd" title={`Add a task to ${col.label}`}
                      onClick={() => { setQuickAddCol(col.key); setQuickAddText(""); }}>＋</button>
                  )}
                </div>
                {quickAddCol === col.key && (
                  <input
                    className="task-quickadd" autoFocus
                    placeholder="Task title, then Enter…"
                    value={quickAddText}
                    onChange={(e) => setQuickAddText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") quickAdd(col.key); if (e.key === "Escape") setQuickAddCol(null); }}
                    onBlur={() => quickAdd(col.key)}
                  />
                )}
                {items.map((t) => {
                  const overdue =
                    t.status !== "done" && t.due_date && t.due_date < today();
                  const cardInner = (
                    <div className={"task-card" + (selectedId === t.id ? " selected" : "")} key={t.id} onClick={() => openTask(t)}>
                      <div className="task-top">
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          {t.content_type && <span className="task-ctype">{CONTENT_LABEL(t.content_type)}</span>}
                          <span className={"task-pri " + t.priority}>{PRI_LABEL[t.priority]}</span>
                          {overdue && (
                            <span className="task-overdue" title={`Due ${t.due_date}, still ${t.status.replace("_", " ")}`}>
                              {(() => { const n = daysOverdue(t.due_date!); return `${n} ${n === 1 ? "day" : "days"} overdue`; })()}
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
                        {t.subtask_total > 0 && (
                          <span className={"task-check" + (t.subtask_done === t.subtask_total ? " full" : "")}>
                            ☑ {t.subtask_done}/{t.subtask_total}
                          </span>
                        )}
                        {t.platforms?.length > 0 && (
                          <span className="task-plats">{t.platforms.map((p) => PLATFORM_META[p]?.icon ?? "").join(" ")}</span>
                        )}
                        <span className="task-code">{taskCode(t.serial)}</span>
                      </div>
                      {canWrite && (
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
                  return canWrite ? (
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
              <div className="task-card dnd-overlay">
                <div className="task-top">
                  <span className={"task-pri " + activeTask.priority}>{PRI_LABEL[activeTask.priority]}</span>
                </div>
                <div className="task-title">{activeTask.title}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {creating && (
        <TaskPanel
          mode="create" task={null} canWrite={canWrite} editors={editors ?? []} channels={(workspaces ?? [])}
          onClose={() => setCreating(false)}
          onChanged={refetch}
          onCreated={(id) => { setCreating(false); setSelectedId(id); refetch(); }}
          onDelete={() => {}}
        />
      )}
      {selectedTask && !creating && (
        <TaskPanel
          mode="edit" task={selectedTask} canWrite={canWrite} editors={editors ?? []} channels={(workspaces ?? [])}
          onClose={() => { setSelectedId(null); refetch(); }}
          onChanged={refetch}
          onCreated={() => {}}
          onDelete={(t) => { setSelectedId(null); del(t); }}
        />
      )}
    </section>
  );
}


function dueLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date();
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days} day${days === 1 ? "" : "s"}`;
  return `Overdue by ${-days} day${-days === 1 ? "" : "s"}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="tp-row"><span className="tp-label">{label}</span><div className="tp-val">{children}</div></div>;
}

// Task detail card. Two modes sharing one layout:
//  - "edit": right-side slide-in; every field saves inline via PATCH.
//  - "create": centered dialog; fields fill a local draft, saved all at once by
//    the "Create task" button. (Checklist/comments need a saved task, so they
//    only appear in edit mode.)
function TaskPanel({ mode, task, canWrite, editors, channels, onClose, onChanged, onCreated, onDelete }: {
  mode: "create" | "edit";
  task: Task | null;
  canWrite: boolean;
  editors: Editor[];
  channels: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDelete: (t: Task) => void;
}) {
  const creating = mode === "create";
  const ro = !canWrite;
  const [draft, setDraft] = useState<{
    channel_id: string | null; editor_id: string | null; due_date: string | null; priority: string;
    status: string; content_type: string | null; platforms: string[]; attachments: TaskAttachment[];
  }>({ channel_id: null, editor_id: null, due_date: null, priority: "medium", status: "todo", content_type: null, platforms: [], attachments: [] });
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(task?.title ?? ""); setDescription(task?.description ?? ""); }, [task?.id]);

  const cur = creating ? draft : {
    channel_id: task!.channel_id, editor_id: task!.editor_id, due_date: task!.due_date, priority: task!.priority,
    status: task!.status, content_type: task!.content_type, platforms: task!.platforms ?? [], attachments: task!.attachments ?? [],
  };

  async function patch(fields: Record<string, unknown>) {
    if (!task) return;
    try { await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(fields) }); onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save."); }
  }
  // Draft-update in create mode; inline PATCH in edit mode.
  function set(localKey: string, apiKey: string, value: unknown) {
    if (creating) setDraft((d) => ({ ...d, [localKey]: value }));
    else patch({ [apiKey]: value });
  }
  function togglePlatform(p: string) {
    const next = cur.platforms.includes(p) ? cur.platforms.filter((x) => x !== p) : [...cur.platforms, p];
    set("platforms", "platforms", next);
  }
  async function create() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify({
        title: title.trim(), description,
        channelId: draft.channel_id, editorId: draft.editor_id, dueDate: draft.due_date,
        priority: draft.priority, status: draft.status, contentType: draft.content_type,
        platforms: draft.platforms, attachments: draft.attachments,
      }) });
      toast.success("Task created.");
      onCreated(r.task.id);
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not create task."); setBusy(false); }
  }

  const inner = (
    <div className="tp-body">
      <div className="tp-head">
        {creating ? <b style={{ fontSize: 17 }}>New Task</b> : (
          <div className="tp-due">
            {task!.due_date ? <><span>📅 {dueLabel(task!.due_date)}</span><small>{task!.due_date}</small></> : <span className="hint" style={{ margin: 0 }}>No due date</span>}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          {!creating && !ro && <button className="btn btn-sm" onClick={() => onDelete(task!)}>🗑 Delete</button>}
          <button className="task-x" onClick={onClose}>✕</button>
        </div>
      </div>
      {!creating && (
        <div className="tp-idrow">
          {task!.content_type && <span className="task-ctype">{CONTENT_LABEL(task!.content_type)}</span>}
          <span className="task-code">{taskCode(task!.serial)}</span>
        </div>
      )}
      <input className="tp-title" autoFocus={creating} placeholder="Task title…" value={title} disabled={ro}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (!creating && title.trim() && title !== task!.title) patch({ title: title.trim() }); }} />
      <textarea className="tp-desc" placeholder="Add a description…" value={description} disabled={ro}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => { if (!creating && description !== (task!.description ?? "")) patch({ description }); }} />

      <div className="tp-fields">
        <Row label="Project">
          <select className="t" disabled={ro} value={cur.channel_id ?? ""} onChange={(e) => set("channel_id", "channelId", e.target.value || null)}>
            <option value="">—</option>
            {channels.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </select>
        </Row>
        <Row label="Assignee">
          <select className="t" disabled={ro} value={cur.editor_id ?? ""} onChange={(e) => set("editor_id", "editorId", e.target.value || null)}>
            <option value="">Unassigned</option>
            {editors.map((ed) => (<option key={ed.id} value={ed.id}>{ed.name}</option>))}
          </select>
        </Row>
        <Row label="Due Date"><input className="t" type="date" disabled={ro} value={cur.due_date ?? ""} onChange={(e) => set("due_date", "dueDate", e.target.value || null)} /></Row>
        <Row label="Priority">
          <select className="t" disabled={ro} value={cur.priority} onChange={(e) => set("priority", "priority", e.target.value)}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </Row>
        <Row label="Status">
          <select className="t" disabled={ro} value={cur.status} onChange={(e) => set("status", "status", e.target.value)}>
            {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label}</option>))}
          </select>
        </Row>
        <Row label="Content Type">
          <select className="t" disabled={ro} value={cur.content_type ?? ""} onChange={(e) => set("content_type", "contentType", e.target.value || null)}>
            <option value="">—</option>
            {CONTENT_TYPES.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
          </select>
        </Row>
        <Row label="Platforms">
          <div className="tp-plats">
            {ALL_PLATFORMS.map((p) => {
              const on = cur.platforms.includes(p);
              return <button key={p} disabled={ro} className={"tp-plat" + (on ? " on" : "")} onClick={() => togglePlatform(p)} title={PLATFORM_META[p].label}>{PLATFORM_META[p].icon}</button>;
            })}
          </div>
        </Row>
        {!creating && (
          <Row label="Repeat">
            <select className="t" disabled={ro} value={task!.recurrence} onChange={(e) => patch({ recurrence: e.target.value })}>
              <option value="none">Doesn't repeat</option><option value="daily">🔁 Daily</option><option value="weekly">🔁 Weekly</option>
            </select>
          </Row>
        )}
      </div>

      <Attachments links={cur.attachments} readOnly={ro} onChange={(next) => set("attachments", "attachments", next)} />

      {creating ? (
        <div className="formfoot" style={{ marginTop: 14 }}>
          <div className="hint" style={{ margin: 0, flex: 1 }}>Checklist &amp; comments become available after you create the task.</div>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={create}>{busy ? "Creating…" : "Create task"}</button>
        </div>
      ) : (
        <>
          <Checklist taskId={task!.id} readOnly={ro} onChanged={onChanged} />
          <Comments taskId={task!.id} />
        </>
      )}
    </div>
  );

  return creating ? (
    <div className="task-panel-scrim center" onClick={onClose}>
      <div className="task-panel centered" onClick={(e) => e.stopPropagation()}>{inner}</div>
    </div>
  ) : (
    <div className="task-panel-scrim" onClick={onClose}>
      <aside className="task-panel" onClick={(e) => e.stopPropagation()}>{inner}</aside>
    </div>
  );
}

function Attachments({ links, readOnly, onChange }: { links: TaskAttachment[]; readOnly: boolean; onChange: (next: TaskAttachment[]) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  function add() {
    let u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { new URL(u); } catch { toast.error("Enter a valid URL."); return; }
    onChange([...links, { url: u, label: label.trim() || undefined }]);
    setUrl(""); setLabel("");
  }
  return (
    <div className="tp-section">
      <div className="tp-sechead">Attachment links</div>
      {links.length === 0 && <div className="hint" style={{ display: "block" }}>No links yet — paste a Drive / Frame.io / YouTube / reference URL.</div>}
      {links.map((a, i) => (
        <div className="tp-link" key={i}>
          <a href={a.url} target="_blank" rel="noopener noreferrer">🔗 {a.label || a.url}</a>
          {!readOnly && <button className="task-x" title="Remove" onClick={() => onChange(links.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {!readOnly && (
        <div className="tp-addlink">
          <input className="t" placeholder="Paste a link…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
          <input className="t" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 130 }} />
          <button className="btn btn-sm" onClick={add}>Add</button>
        </div>
      )}
    </div>
  );
}

function Checklist({ taskId, readOnly = false, onChanged }: { taskId: string; readOnly?: boolean; onChanged?: () => void }) {
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
      onChanged?.();
    } catch { toast.error("Could not add item."); }
  }
  async function toggle(s: Subtask) {
    try {
      const { subtask } = await api<{ subtask: Subtask }>(`/subtasks/${s.id}`, { method: "PATCH", body: JSON.stringify({ done: !s.done }) });
      setItems((x) => x.map((i) => (i.id === s.id ? subtask : i)));
      onChanged?.();
    } catch { toast.error("Could not update item."); }
  }
  async function del(s: Subtask) {
    try {
      await api(`/subtasks/${s.id}`, { method: "DELETE" });
      setItems((x) => x.filter((i) => i.id !== s.id));
      onChanged?.();
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
            <button type="button" className={"chk-box" + (s.done ? " on" : "")} onClick={() => !readOnly && toggle(s)} disabled={readOnly} aria-label="Toggle">{s.done ? "✓" : ""}</button>
            <span className={"chk-title" + (s.done ? " done" : "")}>{s.title}</span>
            {!readOnly && <button type="button" className="chk-del" onClick={() => del(s)} title="Remove">✕</button>}
          </div>
        ))}
        {loading && <div className="hint">Loading…</div>}
        {!loading && items.length === 0 && <div className="hint" style={{ marginTop: 2 }}>Break this task into steps.</div>}
      </div>
      {!readOnly && (
        <div className="chk-add">
          <input className="t" placeholder="Add checklist item…" value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button type="button" className="btn" onClick={add} disabled={!newTitle.trim()}>Add</button>
        </div>
      )}
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

// Phase 2 — dense List view (reuses the .tbl pattern). Search / sort / team
// filter already apply upstream; clicking a row opens the detail panel.
function TaskList({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  return (
    <div className="card pad" style={{ overflowX: "auto" }}>
      <table className="tbl task-tbl">
        <thead>
          <tr>
            <th>Task</th><th>Type</th><th>Assignee</th><th>Project</th>
            <th>Priority</th><th>Due</th><th>Checklist</th><th>Platforms</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.length === 0 ? (
            <tr><td colSpan={9} style={{ textAlign: "center", padding: 26, color: "var(--muted)" }}>No tasks match your search or filters.</td></tr>
          ) : (
            tasks.map((t) => {
              const overdue = t.status !== "done" && t.due_date && t.due_date < today();
              return (
                <tr key={t.id} className="clickrow" onClick={() => onOpen(t)}>
                  <td><b>{t.title}</b> <span className="task-code">{taskCode(t.serial)}</span></td>
                  <td>{t.content_type ? <span className="task-ctype">{CONTENT_LABEL(t.content_type)}</span> : <span className="st dim">—</span>}</td>
                  <td>{t.editor_name ? <Assignee name={t.editor_name} image={t.editor_image} /> : <span className="st dim">—</span>}</td>
                  <td>{t.channel_name ?? <span className="st dim">—</span>}</td>
                  <td><span className={"task-pri " + t.priority}>{PRI_LABEL[t.priority]}</span></td>
                  <td className={overdue ? "num-over" : undefined}>{t.due_date ?? <span className="st dim">—</span>}</td>
                  <td>{t.subtask_total > 0 ? `${t.subtask_done}/${t.subtask_total}` : <span className="st dim">—</span>}</td>
                  <td className="task-plats">{t.platforms?.length ? t.platforms.map((p) => PLATFORM_META[p]?.icon ?? "").join(" ") : <span className="st dim">—</span>}</td>
                  <td><span className={"task-statuschip " + t.status}>{COLUMNS.find((c) => c.key === t.status)?.label}</span></td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
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
