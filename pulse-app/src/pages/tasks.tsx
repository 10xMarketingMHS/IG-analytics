import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, useDraggable, useDroppable, closestCorners,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useContentFormats } from "@/lib/use-content-formats";
import { noteTaskSeen } from "@/lib/use-task-notify";
import { bankedMs, breakOffsetMs, fmtWait, isDayPaused, isOverBudget, OFFICE_CLOSE_HOUR, reviewWaitMs, SLOW_REVIEW_MS } from "@/lib/task-timing";
import { onTasksChanged } from "@/lib/task-events";
import { homeRoleOf, peopleVisibleTo } from "@/lib/home-role";
import { useIsSuper, useOrg } from "@/lib/use-org";
import { tenths } from "@/lib/goal-periods";
import { askStartDay, useDayLocked, useEodState } from "@/lib/eod-context";
import { useAuth } from "@/lib/auth-context";
import { useReviewAccess } from "@/lib/use-review-access";
import { useWorkspaces } from "@/lib/workspaces-context";
import { usePosts } from "@/lib/use-posts";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import { toast } from "sonner";
import type { Task, TaskStatus, TaskPriority, TaskType, TaskMeta, TaskAttachment, TaskReviewLogEntry, ContentFormatDef, Editor, Subtask, TaskComment } from "@/lib/types";
import "./tasks-board.css";
import { HandoverBlock, HandoverInbox, HandoverPill, useHandovers } from "@/components/handover";
import { ScheduleBlock } from "@/components/schedule-block";
import { AdUploadBlock } from "@/components/ad-upload-block";
import { RndUseBlock } from "@/components/rnd-use-block";
import { placeOf, useAdTeams } from "@/lib/ad-teams";
import { clockTime, clockTimeShort, dateTime } from "@/lib/time-format";

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

const TYPE_LABEL: Record<TaskType, string> = {
  content: "Content",
  short_task: "Short task",
  general: "General",
  social: "Social Media",
  ad: "Paid Ad",
  admin: "General",
  service: "Service",
  project: "Project",
};
const TYPE_ICON: Record<TaskType, string> = { content: "📄", short_task: "⚡", general: "🗒️", social: "📱", ad: "📢", admin: "📌", service: "🧰", project: "📁" };
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

// Task content type — a flexible, task-level deliverable tag (separate from the
// post taxonomy, and separate from task_type above). The UI drives the list;
// the backend stores it as free text.
const CONTENT_TYPES: { value: string; label: string }[] = [
  { value: "reel", label: "Reel" },
  { value: "ad_video", label: "Ad Video" },
  { value: "carousel", label: "Carousel" },
  { value: "thumbnail", label: "Thumbnail" },
  { value: "youtube_video", label: "YouTube Video" },
];
const CONTENT_LABEL = (v: string | null) => CONTENT_TYPES.find((c) => c.value === v)?.label ?? null;

// A board task is created under one of two categories — Social or Ads — which
// drives its per-brand id (SID vs AID) and gates the Content Type list: pick a
// category first, then only its content types are offered.
type TaskCategory = "social" | "ad" | "service" | "project" | "admin";
const CATEGORY_LABEL: Record<TaskCategory, string> = { social: "Social", ad: "Ads", service: "Service", project: "Project", admin: "General" };
// A task's category, inferred from its task_type (null for legacy general/short
// tasks that predate the Social/Ads split). "service" is a full peer of
// Social/Ads; "admin" is the General task: a Manager's, Asst. Manager's or Team
// Lead's own, with no content type/timer/scoring, that its owner closes (no review).
const taskCategory = (t: Pick<Task, "task_type">): TaskCategory | null =>
  t.task_type === "social" ? "social"
    : t.task_type === "ad" ? "ad"
    : t.task_type === "service" ? "service"
    : t.task_type === "project" ? "project"
    : t.task_type === "admin" ? "admin"
    : null;
// Display normalizer for the secondary id — old rows stored the "AdID-" prefix,
// new ones store "AID-"; show them all as "AID-".
const showId = (v: string | null | undefined) => (v ? v.replace(/^AdID/i, "AID") : v);

const PLATFORM_META: Record<string, { icon: string; label: string }> = {
  instagram: { icon: "📸", label: "Instagram" },
  facebook: { icon: "👍", label: "Facebook" },
  youtube: { icon: "▶️", label: "YouTube" },
};

const SORTS: { value: string; label: string }[] = [
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Newest" },
  { value: "title", label: "Title" },
];
const PRI_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

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
  { key: "overdue", label: "Overdue" },
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

// Every board filter except the due window — shared by the board itself and
// the counts on the due chips, so the two always agree.
type BoardFilters = { mine: boolean; editorId: string | null; editor: string; type: TaskType | ""; format: string; q: string };
// My tasks: your own, and anyone's waiting for your review (a task you
// assigned comes back to you to review).
const forMyReview = (t: Task) => t.status === "review" && !!t.can_review;
function passesFilters(t: Task, f: BoardFilters) {
  if (f.mine && !forMyReview(t) && (!f.editorId || t.editor_id !== f.editorId)) return false;
  if (f.editor && t.editor_id !== f.editor) return false;
  if (f.type && t.task_type !== f.type) return false;
  if (f.format && t.content_format_id !== f.format) return false;
  if (f.q) {
    const hit =
      t.title.toLowerCase().includes(f.q) ||
      (t.description ?? "").toLowerCase().includes(f.q) ||
      t.tid?.toLowerCase().includes(f.q) ||
      t.sid?.toLowerCase().includes(f.q) ||
      t.ad_id?.toLowerCase().includes(f.q) ||
      t.svid?.toLowerCase().includes(f.q);
    if (!hit) return false;
  }
  return true;
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
  // The day is closed: the clock waits with what it had used.
  if (isDayPaused(t)) {
    const remainingMs = Number(t.budget_hours) * 3_600_000 - bankedMs(t);
    const absMs = Math.abs(remainingMs);
    const h = Math.floor(absMs / 3_600_000);
    const m = Math.floor((absMs % 3_600_000) / 60_000);
    return { scheduled: false, over: remainingMs < 0, paused: true, dayPaused: true, label: h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : "<1m" };
  }
  if (t.budget_hours == null || !t.budget_started_at || t.status === "done") return null;
  const startMs = new Date(t.budget_started_at).getTime();
  if (startMs > nowMs) {
    return { scheduled: true, over: false, paused: false, dayPaused: false, label: `Starts ${new Date(startMs).toLocaleDateString([], { weekday: "short" })} ${clockTime(startMs)}` };
  }
  const deadlineMs = startMs + t.budget_hours * 3_600_000 + breakOffsetMs(t, nowMs);
  const remainingMs = deadlineMs - nowMs;
  const over = remainingMs < 0;
  // On break right now, and not already over even accounting for the break
  // offset — the clock reads as paused (yellow) rather than running (green).
  const paused = !over && !!t.editor_break_started_at;
  const dayPaused = false;
  const absMs = Math.abs(remainingMs);
  const h = Math.floor(absMs / 3_600_000);
  const m = Math.floor((absMs % 3_600_000) / 60_000);
  return { scheduled: false, over, paused, dayPaused, label: h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : "<1m" };
}

// Office hours the acceptance dual-confirmation checks against.
const OFFICE_OPEN_HOUR = 9;
export function officeCloseToday(from: Date) {
  const d = new Date(from);
  d.setHours(OFFICE_CLOSE_HOUR, 0, 0, 0);
  return d;
}
export function nineAmTomorrow(from: Date) {
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
export function classifyWorkload(totalHours: number): 0 | 1 | 2 {
  if (totalHours > WORKLOAD_FULL_HOURS) return 2;
  if (totalHours > WORKLOAD_WARN_HOURS) return 1;
  return 0;
}
export function fmtHours(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
// Time left before office close: "24 min", or "1h 24m" once it's an hour or more.
export function fmtCloseIn(mins: number) {
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Whole days a due date is past today. Both inputs are YYYY-MM-DD; compared via
// Date.UTC so the delta is a clean integer, DST-proof. Returns >= 1 for an
// overdue task (due-today is not overdue — matches the Progress Path < boundary).
function daysOverdue(due: string): number {
  const [dy, dm, dd] = due.split("-").map(Number);
  const [ty, tm, td] = today().split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
}

// A status column that accepts dropped cards; highlights while hovered.
// On phones only the open stage shows (m-open), under its tile.
function DroppableColumn({ id, open, children }: { id: TaskStatus; open?: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} id={`tb-col-${id}`} data-col={id} className={"task-col" + (isOver ? " dnd-over" : "") + (open ? " m-open" : "")}>{children}</div>;
}

// ---- Board card pieces (the redesign's layout: number, title, brand and
// format chips, then who / when / the clock). Display only — every action and
// rule on the card is unchanged.

const tbSvg = (d: ReactNode, size = 15) => (
  <svg className="tb-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const TB_ICON = {
  board: tbSvg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>),
  list: tbSvg(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />),
  calendar: tbSvg(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>),
  me: tbSvg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  team: tbSvg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>),
  overdue: tbSvg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5M12 16h.01" /></>),
  due: tbSvg(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>, 14),
  search: tbSvg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  plus: tbSvg(<path d="M12 5v14M5 12h14" />, 16),
  hold: tbSvg(<path d="M9 5v14M15 5v14" />, 12),
  close: tbSvg(<path d="M18 6 6 18M6 6l12 12" />, 14),
  filter: tbSvg(<path d="M3 5h18l-7 8.5V19l-4 2v-7.5Z" />, 15),
  chevron: tbSvg(<path d="m6 9 6 6 6-6" />, 16),
  hourglass: tbSvg(<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9" />, 13),
  note: tbSvg(<><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13 7l4 4" /></>, 15),
  addTask: tbSvg(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></>, 20),
  status: tbSvg(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>, 15),
  person: tbSvg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, 15),
  event: tbSvg(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>, 15),
  tag: tbSvg(<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />, 15),
  category: tbSvg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><circle cx="17.5" cy="17.5" r="3.5" /></>, 15),
  flag: tbSvg(<path d="M5 21V4h11l-2 4 2 4H5" />, 15),
  link: tbSvg(<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>, 15),
  repeat: tbSvg(<><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>, 15),
  star: tbSvg(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />, 15),
  clock: tbSvg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, 17),
  check: tbSvg(<path d="M20 6 9 17l-5-5" />, 15),
  info: tbSvg(<><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>, 15),
};
// Phones: each stage is a tile you tap to open its cards (see .tb-mtiles).
const STAGE_ICON: Record<TaskStatus, ReactNode> = {
  todo: tbSvg(<circle cx="12" cy="12" r="8" />, 19),
  in_progress: tbSvg(<><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" /></>, 19),
  review: tbSvg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, 19),
  done: tbSvg(<path d="M20 6 9 17l-5-5" />, 19),
};
const MOBILE_STAGE_KEY = "pulse-tasks-mobile-stage";

// The number people know a task by: its brand's SID/AID/SVID/PID, else the TID.
function taskRef(t: Task) {
  return t.sid ? showId(t.sid) : t.ad_id ? showId(t.ad_id) : t.svid ?? t.pid ?? t.tid;
}

// Initials avatar (or photo) — the same look on cards, list rows and pickers.
function Ava({ name, image, size = 26 }: { name: string | null; image?: string | null; size?: number }) {
  if (image) return <img className="tb-ava" src={image} alt="" style={{ width: size, height: size }} />;
  const ini = name ? name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() : "?";
  return (
    <span className="tb-ava init" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: name ? brandDot(name) : undefined }}>{ini}</span>
  );
}

// One colour per brand, by name, for the brand chip's dot.
const BRAND_DOTS = ["#7c3aed", "#16a34a", "#2563eb", "#d97706", "#db2777", "#0891b2", "#9333ea", "#ea580c"];
function brandDot(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BRAND_DOTS[h % BRAND_DOTS.length];
}

// "Today", "Tomorrow", "Overdue · 2d", or "Fri 23 Oct".
function dueText(due: string) {
  const late = daysOverdue(due);
  if (late > 0) return `Overdue · ${late}d`;
  if (late === 0) return "Today";
  if (late === -1) return "Tomorrow";
  return new Date(due + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// How much of a running task's time budget is used, 0–1 (break time doesn't count).
function budgetFrac(t: Task, nowMs: number) {
  if (isDayPaused(t)) return Math.max(0, Math.min(1, bankedMs(t) / (Number(t.budget_hours) * 3_600_000)));
  if (t.budget_hours == null || !t.budget_started_at) return 0;
  const used = nowMs - new Date(t.budget_started_at).getTime() - breakOffsetMs(t, nowMs);
  return Math.max(0, Math.min(1, used / (Number(t.budget_hours) * 3_600_000)));
}

// The card's clock: a small ring for the share of the budget used, and the
// same countdown text as before (time left, over, paused, or when it starts).
function TaskClock({ t, nowMs }: { t: Task; nowMs: number }) {
  const ring = (frac: number, tone: string) => (
    <svg className={"tb-ring " + tone} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" className="tb-ring-track" />
      {frac > 0 && <circle cx="10" cy="10" r="7.5" className="tb-ring-fill" strokeDasharray={`${(frac * 47.1).toFixed(1)} 47.1`} />}
    </svg>
  );
  if (t.status === "done") {
    return <span className="task-timer done" title="Done">{ring(1, "done")}</span>;
  }
  // Accepted but not started: its timer waits for ▶ Start.
  if (t.status === "todo" && t.accepted && t.budget_hours != null && !t.budget_started_at) {
    return <span className="task-timer" title="The timer starts when the task is started">{ring(0, "")}{fmtHours(Number(t.budget_hours))}h</span>;
  }
  const b = budgetInfo(t, nowMs);
  if (!b) return null;
  const cls = b.over ? " over" : b.paused ? " paused" : b.scheduled ? "" : " running";
  const title = b.scheduled
    ? "Timer hasn't started yet"
    : b.over
      ? "Ran past its allotted time — needs follow-up"
      : b.dayPaused
        ? "Paused: the day is closed. It runs again when the day starts."
        : b.paused
          ? "Paused — the assignee is on a break"
          : "Time remaining";
  return (
    <span className={"task-timer" + cls} title={title}>
      {ring(b.scheduled ? 0 : b.over ? 1 : budgetFrac(t, nowMs), cls.trim())}
      {b.scheduled ? b.label : b.over ? `${b.label} over` : `${b.label} left`}
    </span>
  );
}

// An in-progress task's state, at a glance: live (its clock is running) shows a
// green clock whose hand ticks; on a break or with the day closed the clock
// stands still in amber. (On hold says so at the top, and Resume is green.)
function liveState(t: Task, nowMs: number): "live" | "held" | "waiting" | null {
  if (t.status !== "in_progress") return null;
  if (t.on_hold) return "held";
  // its timer starts later (the card says when)
  if (t.budget_started_at && new Date(t.budget_started_at).getTime() > nowMs) return null;
  if (isDayPaused(t) || t.editor_break_started_at) return "waiting";
  return "live";
}
function TickClock({ still = false }: { still?: boolean }) {
  return (
    <svg className={"tb-clock" + (still ? " still" : "")} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" className="tb-clock-face" />
      <line x1="10" y1="10" x2="13" y2="12" className="tb-clock-hand" />
      <line x1="10" y1="11" x2="10" y2="4" className="tb-clock-sec" />
      <circle cx="10" cy="10" r="1.2" className="tb-clock-pin" />
    </svg>
  );
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
  const { active, workspaces, isAdmin, hasPermission } = useWorkspaces();
  const role = active?.role;
  const isSuper = useIsSuper();
  // The Team list: nobody sees people above them (lib/home-role.ts).
  const teamPeople = useMemo(() => {
    const me = (editors ?? []).find((e) => e.id === user?.editorId) ?? null;
    return peopleVisibleTo(editors ?? [], me, { seesAll: isSuper, isAdmin });
  }, [editors, user?.editorId, isAdmin, isSuper]);
  // Access grants that give admin-like reach over other people's tasks.
  // Approve/send back reviews: whoever the task's review goes to — the person
  // who assigned it, or for a task its owner made a Team Lead or Manager. The
  // server says so on each task (can_review); never anyone's own task.
  const canHoldAny = isAdmin || hasPermission("hold_tasks");    // hold/resume anyone's task
  const canAssign = isAdmin || hasPermission("assign_tasks");   // set work up for other people
  const canResolveTask = (t: Task) => t.status === "review" && !!t.can_review && !isOwner(t);
  // Deleting erases the work and its points: a completed task is an admin's
  // call; anything else an assigner's — or yours, if you created it for yourself.
  // The server enforces the same rule.
  const canDeleteTask = (t: Task) =>
    isAdmin || (canWrite && t.status !== "done" && (canAssign || (isOwner(t) && !!user && t.created_by === user.id)));
  // Viewers are read-only (the backend already 403s their writes); hide the
  // status-move controls from them so the affordance matches the permission.
  const canWrite = active?.role !== "viewer";
  const isOwner = (t: Task) => !!user?.editorId && t.editor_id === user.editorId;
  const isGeneral = (t: Task) => t.task_type === "admin";
  // approved R&D work (AI Job) not yet made a Reel, an Ad or both (components/rnd-use-block.tsx)
  const isRnd = (t: Task) => t.task_type === "service" && !!(contentFormats ?? []).find((f) => f.id === t.content_format_id)?.to_scheduling;
  const rndWaiting = (t: Task) => isRnd(t) && t.status === "done" && !t.meta?.use;
  // Review is a checkpoint, not just another column: the assignee moves a
  // task through todo -> in_progress -> review on their own; only an admin
  // can resolve a review — approve it into done, or send it back to
  // in_progress for rework. The backend enforces this too.
  function canTransition(t: Task, target: TaskStatus): boolean {
    if (!canWrite || target === t.status) return false;
    if (t.status === "review") return canResolveTask(t) && (target === "done" || target === "in_progress");
    // A General task skips Review: its owner closes it, and an admin reopens it to
    // In progress (the server does the same)
    if (isGeneral(t) && t.status === "done") return isAdmin && target === "in_progress";
    if (isGeneral(t)) {
      if (target === "review") return false;
      if (target === "done") return isOwner(t) && t.accepted && !t.on_hold;
    }
    if (target === "done") return false; // must go through review
    // Completed is final for the assignee — only an admin reopens approved work.
    if (t.status === "done") return isAdmin && target !== "todo";
    // Once work has started it can't go back to To Do — an admin parks it with
    // Hold instead. And a held task is frozen until an admin resumes it.
    if (t.status === "in_progress" && target === "todo") return false;
    if (t.on_hold && !isAdmin) return false;
    // A task has to be accepted before it can be moved (Start included).
    return isOwner(t) && t.accepted;
  }
  const canMoveStatus = (t: Task) =>
    canWrite && (t.status === "review" ? canResolveTask(t) : t.status === "done" ? isAdmin : isOwner(t));

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
  const [view, setView] = useState<"board" | "list" | "calendar">("board");
  // Right-side detail panel: hold the id, derive the live task so inline edits +
  // refetch keep the panel fresh. `creating` opens the panel in create mode.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Text search — matches title, description, and any of the dual ids
  // (TID/SID/AdID). Also used by List view's search box.
  const [sortBy, setSortBy] = useState("due");
  const openTask = (t: Task) => { setCreating(false); setSelectedId(t.id); };
  // "New Task" (and every per-column ＋) opens the full categorized creation
  // card — Social/Ads → Brand → Content Type. Every new task starts in To Do.
  // New task needs the day started: ask for Start day first, not after the
  // form is filled in (the server refuses it either way).
  const dayLocked = useDayLocked();
  const startNewTask = () => {
    const open = () => { setSelectedId(null); setCreating(true); };
    if (dayLocked) askStartDay("New task", open); else open();
  };
  // A task just made from the sidebar's New task (app-shell) arrives here as
  // { openTask: id }: open it once, then clear the flag so Back or a refresh
  // doesn't reopen it.
  const location = useLocation();
  const navigate = useNavigate();
  const openTaskId = (location.state as { openTask?: string } | null)?.openTask ?? null;
  useEffect(() => {
    if (!openTaskId) return;
    setCreating(false);
    setSelectedId(openTaskId);
    navigate(location.pathname + location.search, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTaskId]);
  const selectedTask = (tasks ?? []).find((t) => t.id === selectedId) ?? null;
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
    // A member filter left over from Team scope makes "My Tasks" look broken
    // (mine AND someone else's editor_id can never both be true) — clear it.
    if (next === "mine") setFilterEditor("");
  }
  // Clicking "Team" while it's already the active scope has nothing else to
  // do, so that click opens the member-filter popover instead — one button
  // covers both "switch to team view" and "filter to one person," instead of
  // a separate always-visible dropdown eating toolbar width.
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const teamMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!teamMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (teamMenuRef.current && !teamMenuRef.current.contains(e.target as Node)) setTeamMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [teamMenuOpen]);
  function onTeamClick() {
    if (scope === "team") { setTeamMenuOpen((o) => !o); return; }
    setScopeAndPersist("team");
  }
  const filteredEditorName = filterEditor ? (editors ?? []).find((e) => e.id === filterEditor)?.name : null;

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
      const f: BoardFilters = { mine: scope === "mine", editorId: user?.editorId ?? null, editor: filterEditor, type: filterType, format: filterFormat, q: search.trim().toLowerCase() };
      const list = effective.filter((t) => passesFilters(t, f) && matchesDueTab(t, dueTab, now));
      // Sort only matters for List view — Board/Calendar group by column/day
      // instead, so this is a no-op there but harmless to always apply.
      const cmp: Record<string, (a: Task, b: Task) => number> = {
        due: (a, b) => (a.due_date ?? "9999-99").localeCompare(b.due_date ?? "9999-99"),
        priority: (a, b) => (PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"),
        created: (a, b) => b.created_at.localeCompare(a.created_at),
        title: (a, b) => a.title.localeCompare(b.title),
      };
      return [...list].sort(cmp[sortBy] ?? cmp.due);
    },
    [effective, scope, user?.editorId, filterEditor, filterType, filterFormat, dueTab, now, search, sortBy],
  );

  const byStatus = (s: TaskStatus) => filtered.filter((t) => t.status === s);
  // Done resets daily on the board — only today's completions show there, so
  // it never grows into an endless scroll. Anything finished on an earlier day
  // is still there, just not on the board — the Calendar shows every day's
  // completions by the day they were actually finished (see TaskCalendar).
  const stageItems = (s: TaskStatus) =>
    s === "done" ? byStatus(s).filter((t) => t.completed_at && ymd(new Date(t.completed_at)) === today()) : byStatus(s);

  // Toolbar summary strip — counts across every OTHER filter (type/format/
  // due-tab/search don't shrink it, so it reads as a stable at-a-glance
  // total) but does respect My Tasks vs Team — otherwise "My Tasks" shows an
  // empty board next to a misleadingly large org-wide number.
  const taskCounts = useMemo(() => {
    const all = scope === "mine"
      ? (tasks ?? []).filter((t) => !!user?.editorId && t.editor_id === user.editorId)
      : (tasks ?? []);
    let social = 0, ad = 0, pendingOverdue = 0, open = 0, openSocial = 0, openAd = 0;
    for (const t of all) {
      if (t.task_type === "social") social++;
      if (t.task_type === "ad") ad++;
      if (t.status !== "done") {
        open++;
        if (t.task_type === "social") openSocial++;
        if (t.task_type === "ad") openAd++;
      }
      const overdue = t.status !== "done" && !!t.due_date && t.due_date < today();
      if (overdue || isOverBudget(t, nowMs)) pendingOverdue++;
    }
    return { total: all.length, social, ad, pendingOverdue, open, openSocial, openAd };
  }, [tasks, nowMs, scope, user?.editorId]);

  // The board fills the window below the toolbar: the toolbar and column
  // titles stay where they are and each column's cards scroll inside it, so a
  // long column doesn't stretch the page (tasks-board.css, --tb-board-h).
  const boardRef = useRef<HTMLDivElement>(null);
  const boardShown = view === "board" && !!tasks && tasks.length > 0;
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty("--tb-board-h", `${Math.max(window.innerHeight - top - 16, 380)}px`);
    };
    const ro = new ResizeObserver(fit);
    const page = el.closest(".tb");
    const bar = page?.querySelector(".tb-bar");
    // Refit whenever anything above the board changes height, appears or goes
    // (the toolbar folding, "Hand-overs for you" after an Accept), so no gap
    // opens below it and it never runs past the window.
    const watchAbove = () => {
      ro.disconnect();
      for (const c of Array.from(page?.children ?? [])) if (!c.contains(el)) ro.observe(c);
      fit();
    };
    watchAbove();
    const mo = new MutationObserver(watchAbove);
    if (page) mo.observe(page, { childList: true });
    // …and once the toolbar's fold finishes opening or closing.
    bar?.addEventListener("transitionend", fit);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); mo.disconnect(); bar?.removeEventListener("transitionend", fit); window.removeEventListener("resize", fit); };
  }, [boardShown]);
  // The number on each due chip: open work in that window, under every other filter.
  const dueCounts = useMemo(() => {
    const f: BoardFilters = { mine: scope === "mine", editorId: user?.editorId ?? null, editor: filterEditor, type: filterType, format: filterFormat, q: search.trim().toLowerCase() };
    const base = effective.filter((t) => t.status !== "done" && passesFilters(t, f));
    const out: Partial<Record<DueTab, number>> = {};
    for (const d of DUE_TABS) out[d.key] = base.filter((t) => matchesDueTab(t, d.key, now)).length;
    return out;
  }, [effective, scope, user?.editorId, filterEditor, filterType, filterFormat, now, search]);
  const filtersOn = !!search.trim() || dueTab !== "all" || !!filterType || !!filterFormat;
  // The toolbar's second row (search, type, format, counts) folds away so the
  // toolbar is one row; Filters opens it, remembered on this device. The
  // number on Filters is how many of those are set while it's folded.
  const [barOpen, setBarOpen] = useState(() => { try { return window.localStorage.getItem("pulse-tasks-toolbar-open") === "1"; } catch { return false; } });
  // Phones: which stage's cards are unfolded under the tiles (none to start;
  // kept while you move around the app).
  // Hand-overs waiting on tasks here (a pill on the card) and for you (above the board).
  const handovers = useHandovers();
  const [mobileStage, setMobileStage] = useState<TaskStatus | null>(() => {
    try { return (window.sessionStorage.getItem(MOBILE_STAGE_KEY) as TaskStatus | null) || null; } catch { return null; }
  });
  const toggleMobileStage = (k: TaskStatus) => setMobileStage((cur) => {
    const next = cur === k ? null : k;
    try { if (next) window.sessionStorage.setItem(MOBILE_STAGE_KEY, next); else window.sessionStorage.removeItem(MOBILE_STAGE_KEY); } catch { /* fine, just not remembered */ }
    return next;
  });
  const toggleBar = () => setBarOpen((o) => {
    try { window.localStorage.setItem("pulse-tasks-toolbar-open", o ? "0" : "1"); } catch { /* fine, just not remembered */ }
    return !o;
  });
  const moreActive = (search.trim() ? 1 : 0) + (filterType ? 1 : 0) + (filterFormat ? 1 : 0);
  const clearFilters = () => { setSearch(""); setDueTab("all"); setFilterType(""); setFilterFormat(""); };

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
          ? (t.review_by ? `Waiting for ${t.review_by} to review it.` : "Only its reviewer can approve or send it back.")
          : isGeneral(t) && status === "review"
            ? "A General task needs no review. Move it to Completed when it is done."
          : status === "done" && !isGeneral(t)
            ? "Move it to Review first."
            : isOwner(t) && !t.accepted
              ? "Accept this task first, then you can move it."
              : "Only the person this task is assigned to can move it.",
      );
      return;
    }
    // Starting a timed task you made yourself runs the same checks as Accept (a
    // heavy day, office hours) — starting it is what starts its clock.
    if (t.status === "todo" && status === "in_progress" && t.accepted && t.budget_hours != null) {
      proceedAccept(t);
      return;
    }
    if (t.status === "review" && status === "in_progress" && reviewNote === undefined) {
      setSendBackPrompt({ task: t });
      setSendBackNote("");
      return;
    }
    // Approving work that was never attached needs a deliberate yes.
    const noWork = t.status === "review" && status === "done" && t.link_required && !t.delivery_link;
    if (noWork && !window.confirm(`No work is attached to "${t.title}". Approve it anyway?`)) return;
    setPending((p) => ({ ...p, [t.id]: status }));
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({
        status, ...(reviewNote ? { reviewNote } : {}), ...(noWork ? { approveWithoutWork: true } : {}),
      }) });
      await refetch();
      toast.success(
        t.status === "done" ? `Reopened “${t.title}”.`
          : status === "done" && isGeneral(t) ? `Completed “${t.title}”.`
          : status === "done" && isRnd(t) ? `Approved “${t.title}”. Open it to decide what it becomes: a Reel, an Ad or both.`
          : status === "done" ? `Approved “${t.title}”.`
          : t.status === "review" ? `Sent “${t.title}” back for rework.`
          : status === "review" ? `Submitted “${t.title}” for review.`
          : `Moved “${t.title}” to ${COLUMNS.find((c) => c.key === status)?.label ?? status}.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update task.");
    } finally {
      setPending((p) => { const n = { ...p }; delete n[t.id]; return n; });
    }
  }

  // Admin-only Hold / Resume — parks an in-progress task (stays In Progress,
  // badge shown, timer paused) or lifts the hold and resumes the clock.
  async function toggleHold(t: Task, next: boolean) {
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ onHold: next }) });
      await refetch();
      toast.success(next ? `Put “${t.title}” on hold.` : `Resumed “${t.title}”.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update hold.");
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
      if (t.accepted) {
        // Already yours (you made it, or picked it up): starting it is what
        // starts its clock — with the same "now or 9 AM tomorrow" choice.
        await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress", startAt: startAt.toISOString() }) });
        toast.success(startAt.getTime() > Date.now() ? "Started — its timer begins as scheduled." : "Started — timer running.");
      } else {
        // Already under way (sent back for rework): accepting resumes its clock.
        await api(`/tasks/${t.id}/accept`, { method: "POST", body: JSON.stringify({ startAt: startAt.toISOString() }) });
        toast.success(
          startAt.getTime() > Date.now() ? "Accepted — its timer resumes as scheduled."
            : t.budget_hours != null ? "Accepted — timer running again."
            : "Accepted.",
        );
      }
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
    // In To Do, Accept only makes it yours — ▶ Start begins the work and its
    // timer (with the workload and office-hours checks). A task already under
    // way resumes straight away instead.
    if (t.status === "todo") {
      acceptOnly(t);
      return;
    }
    proceedAccept(t);
  }

  async function acceptOnly(t: Task) {
    try {
      await api(`/tasks/${t.id}/accept`, { method: "POST", body: "{}" });
      toast.success(t.budget_hours != null
        ? "Accepted — press ▶ Start when you begin. Its timer starts then."
        : "Accepted — press ▶ Start when you begin.");
      if (user) noteTaskSeen(user.id, t.id);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not accept this task.");
    }
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
        setAcceptPrompt({ task: t, closeIn: fmtCloseIn(mins), alreadyClosed });
        return;
      }
    }
    acceptTask(t, now);
  }

  return (
    <section className={"screen tb" + (view === "board" && mobileStage ? " m-freeze" : "")}>
      {/* The redesign's toolbar card. First row: how to look at the board
          (view, whose tasks, when they're due). Second row: search, type and
          format, then the counts in one strip and a new task. */}
      <div className="tb-bar">
        <div className="tb-row">
        <div className="seg tb-views" role="group" aria-label="View">
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>{TB_ICON.board} Board</button>
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>{TB_ICON.list} List</button>
          <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")}>{TB_ICON.calendar} Calendar</button>
        </div>
        <div className="seg tb-scope">
          <button className={scope === "mine" ? "on" : ""} onClick={() => setScopeAndPersist("mine")}>{TB_ICON.me} My tasks</button>
          <div className="team-btn-wrap" ref={teamMenuRef}>
            <button className={"team-btn" + (scope === "team" ? " on" : "")} onClick={onTeamClick}>
              {TB_ICON.team} {filteredEditorName ?? "Team"}
              {scope === "team" && <span className="team-btn-caret">▾</span>}
            </button>
            {teamMenuOpen && (
              <div className="team-menu">
                <button
                  type="button"
                  className={"team-menu-opt" + (!filterEditor ? " on" : "")}
                  onClick={() => { setFilterEditor(""); setTeamMenuOpen(false); }}
                >
                  All team members
                </button>
                {teamPeople.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={"team-menu-opt" + (filterEditor === e.id ? " on" : "")}
                    onClick={() => { setFilterEditor(e.id); setTeamMenuOpen(false); }}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="tb-chips" role="group" aria-label="Due">
          {DUE_TABS.map((d) => {
            const n = dueCounts[d.key] ?? 0;
            return (
              <button key={d.key} type="button" aria-pressed={dueTab === d.key}
                className={"tb-chip" + (dueTab === d.key ? " on" : "") + (d.key === "overdue" ? " over" : "")} onClick={() => setDueTab(d.key)}>
                {d.key === "overdue" ? TB_ICON.overdue : d.key === "all" ? null : TB_ICON.due} {d.label}
                {d.key !== "all" && n > 0 && <span className="tb-chip-n">{n}</span>}
              </button>
            );
          })}
        </div>
        <span className="tb-grow" />
        <button type="button" className={"tb-fold" + (barOpen ? " open" : "")} onClick={toggleBar}
          aria-expanded={barOpen} aria-controls="tb-more" title={barOpen ? "Hide search, filters and counts" : "Show search, filters and counts"}>
          {TB_ICON.filter} Filters
          {moreActive > 0 && <span className="tb-fold-n">{moreActive}</span>}
          <span className="tb-fold-chev">{TB_ICON.chevron}</span>
        </button>
        {canWrite && (
          <button className="tb-new" onClick={() => startNewTask()}>
            {TB_ICON.plus} New task
          </button>
        )}
        </div>
        {/* Folds away to keep the toolbar to one row; Filters opens it. */}
        <div id="tb-more" className={"tb-more" + (barOpen ? " open" : "")} inert={!barOpen}>
        <div className="tb-row">
        <label className="search tb-search">
          {TB_ICON.search}
          <input
            placeholder="Search TID / SID / AID / SVID / title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tasks"
          />
          {search && (
            <button type="button" className="tb-search-x" onClick={() => setSearch("")} aria-label="Clear the search" title="Clear the search">{TB_ICON.close}</button>
          )}
        </label>
        <select
          className={"t tb-select" + (filterType ? " on" : "")}
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as TaskType | "")}
          aria-label="Task type"
        >
          <option value="">All task types</option>
          {(Object.keys(TYPE_LABEL) as TaskType[]).map((tt) => (
            <option key={tt} value={tt}>{TYPE_ICON[tt]} {TYPE_LABEL[tt]}</option>
          ))}
        </select>
        <select
          className={"t tb-select" + (filterFormat ? " on" : "")}
          value={filterFormat}
          onChange={(e) => setFilterFormat(e.target.value)}
          aria-label="Format"
        >
          <option value="">All formats</option>
          {(contentFormats ?? []).map((f) => (
            <option key={f.id} value={f.id}>{f.icon} {f.name}</option>
          ))}
        </select>
        {view === "list" && (
          <select className="t tb-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort tasks" aria-label="Sort tasks">
            {SORTS.map((s) => (<option key={s.value} value={s.value}>↕ {s.label}</option>))}
          </select>
        )}
        {filtersOn && <button type="button" className="tb-clear" onClick={clearFilters}>Clear filters</button>}
        <span className="tb-grow" />
        {/* What's shown, then the open totals (whose tasks still applies). */}
        <div className="tb-strip" aria-label="Task counts" title={`${taskCounts.total} in all · ${taskCounts.social} social · ${taskCounts.ad} ad`}>
          <span><b>{filtered.length}</b> {filtered.length === 1 ? "task" : "tasks"}</span>
          <span><b>{taskCounts.open}</b> open</span>
          <span><b>{taskCounts.openSocial}</b> social</span>
          <span><b>{taskCounts.openAd}</b> ads</span>
          {taskCounts.pendingOverdue > 0 && <span className="bad"><b>{taskCounts.pendingOverdue}</b> pending/overdue</span>}
        </div>
        </div>
        </div>
      </div>

      {scope === "mine" && !user?.editorId && (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
          Your account isn't on the team roster yet, so there's nothing to show here.{" "}
          {isAdmin
            ? "To add yourself, go to Team › Roster and press Edit on your own row."
            : "Ask an admin to link you on Team › Roster."}
        </div>
      )}

      <HandoverInbox onOpen={(id) => { setCreating(false); setSelectedId(id); }} />

      {tasks === null ? (
        <div className="hint">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13.5 }}>
          No tasks yet. Click <b>＋ New task</b> to assign your first daily task to a team member.
        </div>
      ) : view === "list" ? (
        <TaskList tasks={filtered} onOpen={openTask} nowMs={nowMs} />
      ) : view === "calendar" ? (
        <TaskCalendar tasks={filtered} onOpen={openTask} />
      ) : (
        <>
        {/* Phones: the stages as tiles; tap one to unfold its cards, tap again to fold. */}
        <div className="tb-mtiles" role="tablist" aria-label="Stages">
          {COLUMNS.map((col) => {
            const items = stageItems(col.key);
            const late = col.key === "done" ? 0 : items.filter((t) => t.due_date && t.due_date < today()).length;
            const on = mobileStage === col.key;
            const sub = col.key === "done" ? "Finished today" : late > 0 ? `${late} overdue` : items.length === 0 ? "Nothing here" : "On track";
            return (
              <button key={col.key} type="button" role="tab" aria-selected={on} aria-controls={`tb-col-${col.key}`}
                className={"tb-mtile " + col.key + (on ? " on" : "") + (late > 0 ? " late" : "")} onClick={() => toggleMobileStage(col.key)}>
                <span className="tb-mtile-ic">{STAGE_ICON[col.key]}</span>
                <b className="tb-mtile-n">{items.length}</b>
                <span className="tb-mtile-l">{col.label}</span>
                <span className={"tb-mtile-s" + (late > 0 ? " bad" : "")}>{sub}</span>
              </button>
            );
          })}
        </div>
        {!mobileStage && <p className="tb-mhint">Tap a stage to see its tasks.</p>}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
        <div className="task-board" ref={boardRef}>
          {COLUMNS.map((col, ci) => {
            const isDone = col.key === "done";
            const items = stageItems(col.key);
            const olderDoneCount = isDone ? byStatus(col.key).length - items.length : 0;
            return (
              <DroppableColumn id={col.key} key={col.key} open={mobileStage === col.key}>
                <div className="task-colhead">
                  <span className={"tdot " + col.key} /> {col.label}
                  <span className="task-count">{items.length}</span>
                  {canWrite && (
                    <button className="task-coladd" title={`Add a task to ${col.label}`}
                      onClick={() => startNewTask()}>＋</button>
                  )}
                </div>
                {/* The cards scroll here, under the column's title. */}
                <div className="tb-col-body">
                {items.map((t) => {
                  const overdue =
                    t.status !== "done" && t.due_date && t.due_date < today();
                  // The number people know it by (the TID is in the tooltip).
                  const ref = taskRef(t);
                  const mineOnly = scope === "mine" && t.editor_id === user?.editorId;
                  // Waiting on the assignee to accept: their Accept button, or a
                  // note for everyone else. Otherwise the card shows its clock.
                  const acceptSlot = t.editor_id && !t.accepted ? (
                    user?.editorId === t.editor_id ? (
                      <button
                        type="button"
                        className="tb-act pri"
                        onClick={(e) => { e.stopPropagation(); handleAccept(t); }}
                      >
                        {TB_ICON.check} Accept
                      </button>
                    ) : (
                      <span className="tb-act pill" title="Waiting for the assignee to accept">{TB_ICON.hourglass} Pending accept</span>
                    )
                  ) : null;
                  const subtaskSlot = t.subtask_total > 0 && (
                    <span className={"task-check" + (t.subtask_done === t.subtask_total ? " full" : "")} title="Checklist">
                      ☑ {t.subtask_done}/{t.subtask_total}
                    </span>
                  );
                  const actions = (() => {
                    const prevKey = isGeneral(t) && t.status === "done" ? "in_progress" : COLUMNS[ci - 1]?.key;
                    const canPrev = ci > 0 && !!prevKey && canTransition(t, prevKey);
                    // a General task in progress goes straight to Completed (no review)
                    const closesItself = isGeneral(t) && t.status === "in_progress";
                    const nextKey = closesItself ? "done" : COLUMNS[ci + 1]?.key;
                    const canNext = !!nextKey && canTransition(t, nextKey);
                    // An admin, or the task's own assignee, can park (Hold)
                    // or resume an in-progress task — it stays In Progress;
                    // Hold pauses its timer. Same "is this mine" check the
                    // forward-move buttons use (isOwner).
                    // A hold someone else applied (an admin) is theirs to lift,
                    // not the assignee's — mirrors the server.
                    const heldByOther = !canHoldAny && t.on_hold && !!t.held_by && t.held_by !== user?.id;
                    const holdCtrl = (isAdmin || isOwner(t) || canHoldAny) && t.status === "in_progress" ? (
                      t.on_hold ? (
                        heldByOther ? (
                          <span className="tb-act mute" title="Only an admin can resume it">
                            ⏸ Held by {t.held_by_name ?? "an admin"}
                          </span>
                        ) : (
                          <button className="tb-act resume" title="Start its clock again" onClick={() => toggleHold(t, false)}>▶ Resume</button>
                        )
                      ) : (
                        <button className="tb-act hold" title="Pause its clock" onClick={() => toggleHold(t, true)}>⏸ Hold</button>
                      )
                    ) : null;
                    if (!canPrev && !canNext && !holdCtrl) {
                      // In review but this isn't an admin's view — nothing
                      // to do here but wait.
                      return t.status === "review" ? <span className="tb-act mute">{TB_ICON.hourglass} Waiting for review</span> : null;
                    }
                    // Start is the main action; moving on to review is a link;
                    // approving is green; going back is quiet.
                    const nextKind = t.status === "todo" ? "pri" : t.status === "review" || closesItself ? "good" : "link";
                    return (
                      <>
                        {canPrev && (
                          <button className="tb-act ghost" onClick={() => move(t, prevKey!)}>
                            ← {COLUMNS.find((c) => c.key === prevKey)?.label}
                          </button>
                        )}
                        {holdCtrl}
                        {canNext && (
                          <button className={"tb-act next " + nextKind} onClick={() => move(t, nextKey!)}>
                            {t.status === "todo" ? "▶ Start" : closesItself ? <>{TB_ICON.check} Done</> : t.status === "review" ? <>{TB_ICON.check} {COLUMNS[ci + 1].label}</> : `${COLUMNS[ci + 1].label} →`}
                          </button>
                        )}
                      </>
                    );
                  })();
                  const live = liveState(t, nowMs);
                  const liveSlot = !acceptSlot && live === "live" ? (
                    <span className="tb-live" title="Being worked on: its clock is running"><TickClock /> Live</span>
                  ) : !acceptSlot && live === "waiting" ? (
                    <span className="tb-live waiting" title={t.editor_break_started_at ? "Paused: the assignee is on a break" : "Paused: the day is closed"}><TickClock still /> Paused</span>
                  ) : null;
                  const cardInner = (
                    <div
                      className={"task-card pri-" + t.priority + " st-" + t.status + (overdue ? " is-over" : "") + (live === "live" ? " is-live" : live === "held" ? " is-held" : "") + (selectedId === t.id ? " selected" : "")}
                      key={t.id}
                      onClick={() => openTask(t)}
                    >
                      <div className="task-top">
                        <span className="tb-ref" title={t.tid && t.tid !== ref ? `${t.tid}` : undefined}>{ref}</span>
                        {t.revision > 1 && <span className="tb-rev" title="Sent back for rework">Rev {t.revision}</span>}
                        {rndWaiting(t) && <span className="tb-rnd" title="Approved: decide what it becomes, a Reel, an Ad or both">🧪 Reel or Ad?</span>}
                        {t.on_hold && (
                          <span className="task-hold-badge" title={t.held_by_name ? `Held by ${t.held_by_name} — its timer is paused` : "This task is on hold — its timer is paused"}>
                            {TB_ICON.hold} On hold
                          </span>
                        )}
                        <span className="task-flags">
                          {t.post_id && <span title="Auto-created from a post">📄</span>}
                          {t.recurrence !== "none" && <span title={`Repeats ${t.recurrence}`}>🔁</span>}
                          {t.self_created && <span title="Created by the assignee for themselves">🙋</span>}
                        </span>
                        <span className="tb-grow" />
                        <span className={"tb-pri " + t.priority} title={`${PRI_LABEL[t.priority]} priority`}><span className="tb-pri-dot" />{PRI_LABEL[t.priority]}</span>
                        {canDeleteTask(t) && (
                          <button
                            type="button"
                            className="task-x"
                            title="Delete task"
                            aria-label={`Delete ${t.title}`}
                            onClick={(e) => { e.stopPropagation(); del(t); }}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <div className="task-title">{t.title}</div>
                      <div className="tb-chips-row">
                        {placeOf(t) && (
                          <span className="tb-tag"><span className="tb-dot" style={{ background: brandDot(placeOf(t)!) }} />{placeOf(t)}</span>
                        )}
                        <span className="tb-tag" title={TYPE_LABEL[t.task_type]}>
                          {t.content_format_name ? <>{t.content_format_icon} {t.content_format_name}</> : <>{TYPE_ICON[t.task_type]} {TYPE_LABEL[t.task_type]}</>}
                        </span>
                        {t.content_type && <span className="tb-tag">{CONTENT_LABEL(t.content_type)}</span>}
                        {t.platforms?.length > 0 && (
                          <span className="tb-tag task-plats">{t.platforms.map((p) => PLATFORM_META[p]?.icon ?? "").join(" ")}</span>
                        )}
                      </div>
                      {t.pending_note && (
                        <div className="task-rework-note" title={t.pending_note}>
                          {TB_ICON.note}<span>Rework: {t.pending_note}</span>
                        </div>
                      )}
                      {handovers.byTask.get(t.id) && <HandoverPill h={handovers.byTask.get(t.id)!} />}
                      {t.status === "review" && t.review_started_at && (() => {
                        const wait = reviewWaitMs(t, nowMs);
                        return (
                          <div
                            className={"task-review-wait" + (wait >= SLOW_REVIEW_MS ? " slow" : "")}
                            title="How long this has been waiting for a reviewer. This time doesn't count against the assignee."
                          >
                            {TB_ICON.hourglass} Waiting for review {fmtWait(wait)}
                          </div>
                        );
                      })()}
                      <div className="task-meta">
                        {/* Every card in "My Tasks" is already yours — showing your own name on each one is noise */}
                        {!mineOnly && (
                          <span className="tb-who" title={t.editor_name ?? "Unassigned"}>
                            <Ava name={t.editor_name} image={t.editor_image} />
                          </span>
                        )}
                        {t.status === "done" ? (
                          <span className="task-due done" title={t.completed_at ? `Done ${dateTime(t.completed_at)}` : "Done"}>{TB_ICON.due} Done</span>
                        ) : t.due_date ? (
                          <span className={"task-due" + (overdue ? " over" : t.due_date === today() ? " today" : "")} title={t.due_date}>
                            {TB_ICON.due} {dueText(t.due_date)}
                          </span>
                        ) : null}
                        <span className="tb-grow" />
                        {subtaskSlot}
                        {!acceptSlot && <TaskClock t={t} nowMs={nowMs} />}
                      </div>
                      {(acceptSlot || liveSlot || actions) && (
                        <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                          {acceptSlot}
                          {liveSlot}
                          {actions}
                        </div>
                      )}
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
                </div>
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
        </>
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
          onDelete={canDeleteTask(selectedTask) ? (t) => { setSelectedId(null); del(t); } : undefined}
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
                    <b>{acceptPrompt.task.title}</b> needs <b>{fmtHours(Number(acceptPrompt.task.budget_hours))}h</b>, and office
                    hours already closed for today (6:00 PM). Starting now means the whole thing runs
                    outside office hours.
                  </>
                ) : (
                  <>
                    <b>{acceptPrompt.task.title}</b> needs <b>{fmtHours(Number(acceptPrompt.task.budget_hours))}h</b>, but office
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
                Continue anyway
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
  const isSuper = useIsSuper();
  const me = editors.find((ed) => ed.id === user?.editorId) ?? null;
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
        setScheduleConflict({ taskId: saved.id, closeIn: fmtCloseIn(mins), alreadyClosed });
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
          {task.sid && <><span className="dot-sep">·</span><span>{showId(task.sid)}</span></>}
          {task.ad_id && <><span className="dot-sep">·</span><span>{showId(task.ad_id)}</span></>}
          {task.svid && <><span className="dot-sep">·</span><span>{task.svid}</span></>}
        </div>
      )}
      <form onSubmit={submit}>
        <div className="field">
          <label className="f">Task <span className="req">*</span></label>
          <input className="t" placeholder="e.g. Edit Diabetes reel" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label className="f">Details</label>
          <textarea className="t" placeholder="Optional notes…" value={description} maxLength={20000} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid g3">
          <div className="field">
            <label className="f">Assign to</label>
            {isAdmin ? (
              <select className="t" value={editorId} onChange={(e) => setEditorId(e.target.value)}>
                <option value="">Unassigned</option>
                {/* Admins aren't assignable editors, nor anyone above you (keep a chosen one visible). */}
                {peopleVisibleTo(editors, me, { seesAll: isSuper, isAdmin }, editorId).filter((ed) => !ed.is_admin || ed.id === editorId).map((ed) => (
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
        {/* New tasks always start in To Do — the status picker is only for moving
            an existing task between stages, so it's hidden while creating. */}
        {editing && (
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
            <div className="hint" style={{ marginTop: 6 }}>⏳ Waiting for review — only a reviewer can approve or send it back.</div>
          )}
        </div>
        )}
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
              ⏱ {fmtHours(Number(task.budget_hours))}h, started {dateTime(task.budget_started_at!)} — set by your admin, not editable here.
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

function dueLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date();
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days} day${days === 1 ? "" : "s"}`;
  return `Overdue by ${-days} day${-days === 1 ? "" : "s"}`;
}

function Row({ label, icon, note, children }: { label: string; icon?: ReactNode; note?: string; children: ReactNode }) {
  return (
    <div className="tp-row">
      <span className="tp-label">{icon}<span>{label}{note && <small className="tp2-req">{note}</small>}</span></span>
      <div className="tp-val">{children}</div>
    </div>
  );
}

// (The number a new task will be given is the server's to say: GET /tasks/next-ref.)

// One-tap due dates for a new task: today, tomorrow, and the coming Friday
// and Monday.
// The New task sheet's kinds of work, each with what it covers.
const KINDS: { k: TaskCategory; icon: string; label: string; sub: string; leadsOnly?: boolean }[] = [
  { k: "social", icon: "📣", label: "Social", sub: "Reels, carousels, posts" },
  { k: "ad", icon: "💰", label: "Ads", sub: "Ad videos for the teams" },
  { k: "service", icon: "🧰", label: "Service", sub: "Schedule, requests" },
  { k: "project", icon: "📁", label: "Project", sub: "Bigger work, with a start" },
  { k: "admin", icon: "📌", label: "General", sub: "Just for you · close it yourself", leadsOnly: true },
];
// Its due picks: Today, Tomorrow, and the next two working days — no Sundays,
// no Saturdays when the office is shut then, no holidays (Settings › General).
function workDues(cal?: { satOff?: boolean; holidays?: string[] } | null) {
  const now = new Date();
  const out = [{ label: "Today", value: ymd(now) }, { label: "Tomorrow", value: ymd(addDays(now, 1)) }];
  const off = (d: Date) => d.getDay() === 0 || (d.getDay() === 6 && !!cal?.satOff) || (cal?.holidays ?? []).includes(ymd(d));
  for (let d = addDays(now, 2); out.length < 4; d = addDays(d, 1)) {
    if (!off(d)) out.push({ label: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }), value: ymd(d) });
  }
  return out;
}

function quickDues() {
  const now = new Date();
  const out = [{ label: "Today", value: ymd(now) }, { label: "Tomorrow", value: ymd(addDays(now, 1)) }];
  for (const dow of [5, 1]) {
    let d = addDays(now, 2);
    while (d.getDay() !== dow) d = addDays(d, 1);
    out.push({ label: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }), value: ymd(d) });
  }
  return out.sort((a, b) => a.value.localeCompare(b.value));
}

// The time budget as a card: where its clock is, time used so far, and how
// much of the budget that is. The same numbers the board's ring shows.
function TimerCard({ t }: { t: Task }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const budgetMs = Number(t.budget_hours) * 3_600_000;
  const startMs = t.budget_started_at ? new Date(t.budget_started_at).getTime() : null;
  const b = budgetInfo(t, nowMs);
  const running = startMs != null && startMs <= nowMs && t.status !== "done";
  // A stopped clock (on hold, or the day closed) shows the time it had banked.
  const usedMs = running ? Math.max(0, nowMs - startMs - breakOffsetMs(t, nowMs)) : bankedMs(t);
  const frac = t.status === "done" ? 1 : budgetMs ? Math.min(1, usedMs / budgetMs) : 0;
  const tone = t.status === "done" ? "done" : t.on_hold || b?.paused ? "paused" : b?.over ? "over" : running ? "running" : "";
  const state = t.status === "done" ? "Done"
    : t.on_hold ? "Paused — on hold"
    : b?.dayPaused ? "Paused · day closed. It runs again when you start your day"
    : b?.scheduled ? b.label
    : !running ? (t.status === "todo" ? "Not started — starts with ▶ Start" : "Not started")
    : b?.paused ? "Paused — on a break"
    : t.status === "review" ? "In review"
    : b?.over ? `Running · ${b.label} over budget`
    : `Running · ${b?.label ?? ""} left`;
  const h = Math.floor(usedMs / 3_600_000);
  const m = Math.floor((usedMs % 3_600_000) / 60_000);
  const s = Math.floor((usedMs % 60_000) / 1000);
  return (
    <div className={"tp2-timer " + tone}>
      <div className="tp2-timer-top">{TB_ICON.clock}<span>{state}</span><span className="tp2-grow" /><span className="tp2-faint">{fmtHours(Number(t.budget_hours))}h budget</span></div>
      <div className="tp2-timer-mid">
        <span className="tp2-timer-n">{t.status === "done" ? "—" : `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`}</span>
        {t.status !== "done" && <span className="tp2-faint">{Math.round((budgetMs ? usedMs / budgetMs : 0) * 100)}% used</span>}
      </div>
      <div className="tp2-bar"><span style={{ width: `${(frac * 100).toFixed(1)}%` }} /></div>
    </div>
  );
}

// A second, richer detail view — the right-side slide-in / centered-create
// dialog TasksPage itself renders (TaskModal above is a separate, simpler
// standalone version used by the Social Media page). Two modes sharing one
// layout:
//  - "edit": right-side slide-in; every field saves inline via PATCH.
//  - "create": centered dialog; fields fill a local draft, saved all at once
//    by the "Create task" button. (Checklist/comments/review history need a
//    saved task, so they only appear in edit mode.)
// Status changes here follow the same review-checkpoint rule the board and
// backend enforce: only the assignee can move todo/in_progress/review; only
// an admin resolves a review. Sending a task back to In Progress isn't
// offered here — it requires a rework note, which the board's dedicated
// prompt collects; approving (→ Completed) doesn't need one, so that stays
// available inline.
// Exported so My Day's review queue can open the same panel. `onDelete` is
// optional — leave it out where deleting isn't offered and the button is hidden.
export function TaskPanel({ mode, task, canWrite, editors, channels, onClose, onChanged, onCreated, onDelete }: {
  mode: "create" | "edit";
  task: Task | null;
  canWrite: boolean;
  editors: Editor[];
  channels: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDelete?: (t: Task) => void;
}) {
  const creating = mode === "create";
  const { user } = useAuth();
  const { isAdmin, hasPermission } = useWorkspaces();
  const isSuper = useIsSuper();
  const review = useReviewAccess();
  // People to assign to: nobody sees people above them (lib/home-role.ts); a
  // task's current assignee stays listed. An Assign tasks grant limited to some
  // people (Settings › Access) lists only them (and you).
  const assignTo = !isAdmin ? review.assignScope?.editors ?? null : null;
  const assignPeople = useMemo(() => {
    const me = editors.find((e) => e.id === user?.editorId) ?? null;
    const seen = peopleVisibleTo(editors, me, { seesAll: isSuper, isAdmin }, task?.editor_id ?? null);
    return assignTo ? seen.filter((e) => assignTo.includes(e.id) || e.id === user?.editorId || e.id === task?.editor_id) : seen;
  }, [editors, user?.editorId, isAdmin, isSuper, task?.editor_id, assignTo]);
  // Access grants: assign tasks to others, and resolve reviews.
  const canAssign = isAdmin || hasPermission("assign_tasks");
  // A Manager, Asst. Manager or Team Lead decides what approved R&D work becomes (the server holds the same line)
  const decidesRnd = isAdmin || homeRoleOf(editors.find((e) => e.id === user?.editorId)?.designation, isAdmin) !== "editor";
  const ro = !canWrite;
  // Delivery Link is writable by the task's assignee or an admin (mirrors the
  // server check); everyone else who can open the panel sees it read-only.
  const isOwnerTask = !!user?.editorId && task?.editor_id === user.editorId;
  const canResolve = !!task && task.status === "review" && !!task.can_review && !isOwnerTask;
  // A reviewer approves or sends back from the foot of the window, where reading it ends
  // (sending back takes a note: what needs fixing).
  const [backOpen, setBackOpen] = useState(false);
  const [backNote, setBackNote] = useState("");
  const [resolving, setResolving] = useState(false);
  // Who may change what — mirrors the server (PATCH /tasks/:id):
  //  - a completed task is frozen as approved; only an admin changes it;
  //  - the brief (title, description, brand, type, dates, priority, repeat)
  //    belongs to whoever set the task up: an assigner, or the assignee when
  //    they created the task for themselves;
  //  - handing a task to someone is for assigners;
  //  - the working parts (links, checklist) are the assignee's.
  const isDoneTask = !creating && task?.status === "done";
  const selfMade = isOwnerTask && !!user && task?.created_by === user.id;
  const canEditBrief = creating || (!ro && (isAdmin || (!isDoneTask && (isOwnerTask ? selfMade : canAssign))));
  const canReassign = creating || (!ro && (isAdmin || (!isDoneTask && canAssign)));
  const canEditWork = creating || (!ro && (isAdmin || (!isDoneTask && (isOwnerTask || canAssign))));
  const canTake = !creating && !ro && !canReassign && !isDoneTask && !!user?.editorId && !task?.editor_id;
  const briefRo = !canEditBrief;
  const canEditDelivery = canEditWork && (isAdmin || isOwnerTask);
  // Whether it needs a review link: an admin, or someone who may assign work
  // and set this task up (gave it, or made it for themselves) — the server's rule.
  const setUpByMe = !!task && !!user && (task.assigned_by === user.id
    || (task.created_by === user.id && (!task.assigned_by || !task.editor_id)));
  const canSetLink = creating ? canAssign : isAdmin || (canAssign && setUpByMe);
  const { contentFormats } = useContentFormats();
  const [draft, setDraft] = useState<{
    channel_id: string | null; editor_id: string | null; due_date: string | null; start_date: string | null; priority: string;
    status: string; content_format_id: string | null; attachments: TaskAttachment[]; ad_team_id: string | null;
    requested_by: string; budget_hours: number | null;
  }>({ channel_id: null, editor_id: null, due_date: null, start_date: null, priority: "medium", status: "todo", content_format_id: null, attachments: [], ad_team_id: null, requested_by: "", budget_hours: null });
  // Ads are made for a team (VSL, Longer Life, Webinar) and numbered within it, not a brand
  const { adTeams } = useAdTeams();
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [busy, setBusy] = useState(false);
  // Other work (server/src/goal-score.js): which team asked, and how long it should take
  const [askedBy, setAskedBy] = useState(task?.meta?.requestedBy ?? "");
  const [shouldTake, setShouldTake] = useState(task?.budget_hours != null ? String(task.budget_hours) : "");
  // Closing plays the sheet back down (the drawer back out) before the panel
  // goes, the way it came in. Skipped when the viewer asks for less motion.
  const [leaving, setLeaving] = useState(false);
  function close() {
    if (leaving) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    setLeaving(true);
    window.setTimeout(onClose, creating ? 320 : 220);
  }
  // New task: whether it needs a delivery link for review. null = follow the
  // chosen content type; set once the assigner ticks/unticks it themselves.
  const [linkOverride, setLinkOverride] = useState<boolean | null>(null);
  // Board tasks are created as Social or Ads (chosen first); Content Type stays
  // hidden until one is picked. In edit mode the category is fixed by the task's
  // existing task_type (never re-picked here — that would churn its SID/AID).
  const [category, setCategory] = useState<TaskCategory | null>(null);
  const editCategory = task ? taskCategory(task) : null;
  const activeCategory: TaskCategory | null = creating ? category : editCategory;
  // Admin tasks (admin-only) are a bare personal category: only Title +
  // Description, no project / assignee / due / priority / content type /
  // attachments, self-assigned, and they start In Progress. `adminTask` gates
  // the create form; `adminEdit` handles an existing admin task being viewed.
  const adminTask = creating && category === "admin";
  const adminEdit = !creating && editCategory === "admin";
  // Content types come from the admin taxonomy (Settings → Task Settings). When
  // a category is chosen we scope to it; before that (create, nothing picked)
  // we offer every active type so the dropdown is usable right away — picking
  // one then sets the category from that type (see onPickContentType).
  const contentTypeChoices = (contentFormats ?? []).filter(
    (f) => f.active && (activeCategory ? f.category === activeCategory : true),
  );
  useEffect(() => { setTitle(task?.title ?? ""); setDescription(task?.description ?? ""); }, [task?.id]);
  // Picking/switching category in create mode clears a now-invalid content type
  // (each category has its own list).
  function pickCategory(next: TaskCategory) {
    setCategory(next);
    // A Project needs a Start Date (defaults to today) and its own type list.
    setDraft((d) => ({ ...d, content_format_id: null, start_date: next === "project" ? (d.start_date ?? today()) : d.start_date }));
  }
  // Choosing a content type also settles the category (Reel → Social, Ad Video
  // → Ads) when one hasn't been picked yet, so the two never disagree.
  function onPickContentType(id: string | null) {
    set("content_format_id", "contentFormatId", id);
    // A different type brings its own default back.
    if (creating) setLinkOverride(null);
    if (creating && id) {
      const f = (contentFormats ?? []).find((x) => x.id === id);
      if (f?.category && f.category !== category) setCategory(f.category);
    }
  }

  // Self vs. Assign toggle for new tasks — most tasks anyone creates (admin
  // included) are for themselves, so defaulting to a mandatory "pick a name"
  // dropdown made every self-task an extra click. Only meaningful in create
  // mode, and only when the creator actually has a linked roster record to
  // assign to ("Myself" is meaningless otherwise — same gate as the "mine"
  // scope banner above).
  const canSelfAssign = Boolean(user?.editorId);
  const [assignMode, setAssignMode] = useState<"self" | "assign">(canSelfAssign ? "self" : "assign");
  function setMode(next: "self" | "assign") {
    setAssignMode(next);
    if (creating) setDraft((d) => ({ ...d, editor_id: next === "self" ? (user?.editorId ?? null) : null }));
  }
  useEffect(() => {
    if (creating && assignMode === "self") setDraft((d) => ({ ...d, editor_id: user?.editorId ?? null }));
    // Only on mount for create mode — after that, setMode() owns the sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cur = creating ? draft : {
    channel_id: task!.channel_id, editor_id: task!.editor_id, due_date: task!.due_date, start_date: task!.start_date, priority: task!.priority,
    status: task!.status, content_format_id: task!.content_format_id, attachments: task!.attachments ?? [], ad_team_id: task!.ad_team_id ?? null,
  };
  // An Ad task picks its team once there are teams (Settings › Tasks & time › Ads teams)
  const adByTeam = activeCategory === "ad" && (adTeams?.length ?? 0) > 0;
  // Project-only derived values: the selected project type drives its duration
  // (which bounds the Due Date) and its read-only points. Declared after `cur`.
  const isProject = activeCategory === "project";
  const selectedFormat = (contentFormats ?? []).find((f) => f.id === cur.content_format_id) ?? null;
  // An Assign tasks grant limited to some content types (Settings › Access)
  // covers only those types on other people's tasks; the server holds the same
  // line. Your own tasks can be any type.
  const assignLimit = !isAdmin && review.assignScope?.formats ? review.assignScope.formats : null;
  const limitTypes = assignLimit && !!cur.editor_id && cur.editor_id !== user?.editorId ? assignLimit : null;
  const typeChoices = limitTypes
    ? contentTypeChoices.filter((f) => limitTypes.includes(f.id) || (!creating && f.id === cur.content_format_id))
    : contentTypeChoices;
  const limitNames = (contentFormats ?? []).filter((f) => assignLimit?.includes(f.id)).map((f) => f.name).join(", ") || "certain content types";
  // Picking someone else clears a type they can't be given.
  useEffect(() => {
    if (creating && limitTypes && draft.content_format_id && !limitTypes.includes(draft.content_format_id)) {
      setDraft((d) => ({ ...d, content_format_id: null }));
    }
  }, [creating, limitTypes, draft.content_format_id]);
  const linkRequired = creating
    ? (linkOverride ?? selectedFormat?.review_link_required ?? false)
    : !!task?.link_required;
  const projectDuration = isProject ? (selectedFormat?.duration_days ?? null) : null;
  const projectPoints = isProject ? (selectedFormat?.points ?? null) : null;
  const dueMax = isProject && cur.start_date != null && projectDuration != null
    ? ymd(addDays(new Date(`${cur.start_date}T00:00:00`), projectDuration))
    : undefined;
  // New task sheet: the number it'll get (a look, nothing taken), and how it
  // scores for its person (GET /goals/preview)
  const { org } = useOrg();
  const [nextRef, setNextRef] = useState<string | null>(null);
  useEffect(() => {
    if (!creating || !category) { setNextRef(null); return; }
    const p = new URLSearchParams({ category });
    if (adByTeam && draft.ad_team_id) p.set("adTeamId", draft.ad_team_id);
    if (!adByTeam && draft.channel_id) p.set("channelId", draft.channel_id);
    let live = true;
    api<{ ref: string | null }>(`/tasks/next-ref?${p.toString()}`).then((r) => { if (live) setNextRef(r.ref); }).catch(() => { if (live) setNextRef(null); });
    return () => { live = false; };
  }, [creating, category, adByTeam, draft.ad_team_id, draft.channel_id]);
  // Service › Something else: an off-goal request that has no type of its own,
  // so the Brief says what it is (required)
  const [otherPick, setOtherPick] = useState(false);
  const elseNeedsBrief = creating && otherPick && !description.trim();
  useEffect(() => { setOtherPick(false); }, [category]);
  const [preview, setPreview] = useState<{
    goalPoints: number; reached: number; pct: number | null; monthHours: number; timeFactor: number; otherHours: number; leaveDays: number;
    inGoal: boolean; typeName: string | null; points: number | null; typeGoal: { goal: number; done: number } | null;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Their goal, type by type (GET /goals/preview's goalTypes), for the type chips: "3 to go"
  type GoalType = { contentFormatId: string; goal: number; done: number; open: number; need: number; points: number };
  const [goalInfo, setGoalInfo] = useState<{ goalPoints: number; types: GoalType[] } | null>(null);
  useEffect(() => {
    if (!creating || !draft.editor_id) { setGoalInfo(null); return; }
    let live = true;
    api<{ preview: { goalPoints: number; goalTypes?: GoalType[] } | null }>(`/goals/preview?editorId=${draft.editor_id}`)
      .then((r) => { if (live) setGoalInfo(r.preview ? { goalPoints: r.preview.goalPoints, types: r.preview.goalTypes ?? [] } : null); })
      .catch(() => { if (live) setGoalInfo(null); });
    return () => { live = false; };
  }, [creating, draft.editor_id]);
  // For yourself, with a goal this month: only the goal types in it (see the type
  // chips). A type picked before the goal came in, and not in it, is let go.
  const ownGoalOnly = creating && !!draft.editor_id && draft.editor_id === user?.editorId && !!goalInfo && goalInfo.goalPoints > 0;
  useEffect(() => {
    if (!ownGoalOnly || !draft.content_format_id) return;
    const f = (contentFormats ?? []).find((x) => x.id === draft.content_format_id);
    if (f && f.counts_in_goal !== false && !goalInfo!.types.some((g) => g.contentFormatId === f.id)) setDraft((d) => ({ ...d, content_format_id: null }));
  }, [ownGoalOnly, goalInfo, draft.content_format_id, contentFormats]);
  useEffect(() => {
    if (!creating || !draft.editor_id || !(draft.content_format_id || otherPick) || category === "admin") { setPreview(null); return; }
    let live = true;
    setPreviewBusy(true);
    const t = setTimeout(() => {
      api<{ preview: typeof preview }>(`/goals/preview?editorId=${draft.editor_id}${draft.content_format_id ? `&contentFormatId=${draft.content_format_id}` : ""}`)
        .then((r) => { if (live) setPreview(r.preview); })
        .catch(() => { if (live) setPreview(null); })
        .finally(() => { if (live) setPreviewBusy(false); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [creating, draft.editor_id, draft.content_format_id, otherPick, category]);

  async function patch(fields: Record<string, unknown>) {
    if (!task) return;
    const approving = task.status === "review" && fields.status === "done";
    const noWork = approving && task.link_required && !task.delivery_link;
    if (noWork && !window.confirm(`No work is attached to "${task.title}". Approve it anyway?`)) return;
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(noWork ? { ...fields, approveWithoutWork: true } : fields) });
      onChanged();
      toast.success(approving ? `Approved “${task.title}”.` : "Saved.");
    }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Couldn't save."); }
  }
  async function approve() {
    setResolving(true);
    try { await patch({ status: "done" }); } finally { setResolving(false); }
  }
  async function sendBack() {
    if (!task || !backNote.trim()) return;
    setResolving(true);
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress", reviewNote: backNote.trim() }) });
      onChanged();
      setBackOpen(false);
      setBackNote("");
      toast.success(`Sent back to ${task.editor_name ?? "the editor"} for rework.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send it back.");
    } finally {
      setResolving(false);
    }
  }
  // Draft-update in create mode; inline PATCH in edit mode.
  function set(localKey: string, apiKey: string, value: unknown) {
    if (creating) setDraft((d) => ({ ...d, [localKey]: value }));
    else patch({ [apiKey]: value });
  }
  // A board task must declare its category and belong to a brand (Project) —
  // that's what its per-brand SID/AID is numbered against.
  // Admin tasks need no project; every other category is numbered per brand.
  // A Project must have its type picked first (it drives duration + points).
  // An Admin task is assigned to its creator, so the creator must be on the roster.
  const adminNeedsRoster = category === "admin" && !user?.editorId;
  // The day must be started to make a task (the server refuses it otherwise):
  // said at the top of the form, re-checked as it opens in case it closed meanwhile.
  const dayLocked = useDayLocked();
  const { refresh: refreshDay, start: startDay, busy: dayBusy } = useEodState();
  useEffect(() => { if (creating) refreshDay(); }, [creating, refreshDay]);
  const canCreate = Boolean(title.trim() && category && !adminNeedsRoster && (category === "admin" || (adByTeam ? draft.ad_team_id : draft.channel_id)) && (category !== "project" || draft.content_format_id)
    && (!limitTypes || category === "admin" || !!draft.content_format_id)) && !(creating && dayLocked) && !elseNeedsBrief;
  async function create() {
    if (!canCreate || busy) return;
    setBusy(true);
    try {
      const r = await api<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify({
        // Every new task starts in To Do, regardless of where it was opened from.
        title: title.trim(), description, taskType: category, status: "todo",
        channelId: adByTeam ? null : draft.channel_id, editorId: draft.editor_id, dueDate: draft.due_date,
        ...(adByTeam ? { adTeamId: draft.ad_team_id } : {}),
        startDate: category === "project" ? draft.start_date : undefined,
        priority: draft.priority, contentFormatId: draft.content_format_id,
        ...(canAssign && linkOverride != null ? { reviewLinkRequired: linkOverride } : {}),
        // given to someone: which team asked, and how long it should take
        ...(draft.editor_id && draft.editor_id !== user?.editorId ? {
          requestedBy: draft.requested_by.trim() || undefined,
          budgetHours: draft.budget_hours ?? undefined,
        } : {}),
        attachments: draft.attachments,
      }) });
      toast.success("Task created.");
      onCreated(r.task.id);
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not create task."); setBusy(false); }
  }

  // Which status options are selectable from here — mirrors the board's
  // canTransition rule: only the assignee moves a task among
  // todo/in_progress/review; only an admin resolves a review, and only into
  // "done" (sending back needs a note — use the board's send-back prompt).
  const statusOptions = COLUMNS.filter((c) => {
    if (creating || !task) return true;
    if (c.key === task.status) return true;
    if (task.status === "review") return canResolve && c.key === "done";
    if (task.status === "done") return isAdmin && (task.task_type === "admin" ? c.key === "in_progress" : c.key !== "todo");
    // The assignee moves it — once they've accepted it. A General task skips
    // Review: its owner sets it to Completed.
    const general = task.task_type === "admin";
    return (general ? c.key !== "review" : c.key !== "done") && !!user?.editorId && task.editor_id === user.editorId && task.accepted;
  });

  // The redesign's look: a sheet that rises from the bottom to create a task,
  // a drawer on the right to view and edit one. Same fields, same rules, same
  // saves as before — only the arrangement and the controls' look changed.
  const ic = (x: ReactNode) => (creating ? undefined : x);
  const ref = task ? taskRef(task) : null;
  const otherIds = task ? [task.tid, showId(task.sid), showId(task.ad_id), task.svid, task.pid].filter((x): x is string => !!x && x !== ref) : [];
  const rule = creating || !task ? ""
    : task.status === "review" ? (canResolve
      ? "To approve, set Status to Completed. Sending back for rework needs a note — use the Send back / ← button."
      : task.review_by ? `⏳ Waiting for ${task.review_by} to review it.` : "⏳ Waiting on review.")
    : task.status === "in_progress" && task.task_type === "admin" ? "A General task needs no review: set Status to Completed when it's done."
    : task.status === "in_progress" ? "Use Hold on the board to park it — a started task can't go back to To Do."
    : "";
  const meEditor = editors.find((ed) => ed.id === user?.editorId);
  const selfChip = (
    <span className="tp2-person on static"><Ava name={meEditor?.name ?? "Myself"} image={meEditor?.image_url} size={24} />{meEditor?.name ?? "Myself"}<small>you</small></span>
  );
  const overdueEdit = !creating && task!.status !== "done" && !!task!.due_date && task!.due_date < today();

  const statusRow = !creating && (
    <Row label="Status" icon={TB_ICON.status}>
      <span className={"tp2-sel-dot st-" + cur.status} />
      <select className="t" disabled={ro || statusOptions.length <= 1} value={cur.status} onChange={(e) => set("status", "status", e.target.value)}>
        {statusOptions.map((c) => (<option key={c.key} value={c.key}>{c.label}</option>))}
      </select>
    </Row>
  );
  const assigneeRow = (
    <Row label="Assignee" icon={ic(TB_ICON.person)}>
      {adminTask || adminEdit ? (
        /* Admin tasks are always self-assigned — no Assign option. */
        creating ? selfChip : <div className="t autofield">{meEditor?.name ?? "Myself"}</div>
      ) : (
        <>
          {/* Admins — and assign_tasks grantees — can assign work to someone
              else. Everyone else creates tasks for themselves only. */}
          {creating && canSelfAssign && canAssign && (
            <div className="seg assign-mode-seg tp2-seg">
              <button type="button" className={assignMode === "self" ? "on" : ""} onClick={() => setMode("self")}>🙋 Myself</button>
              <button type="button" className={assignMode === "assign" ? "on" : ""} onClick={() => setMode("assign")}>👥 Assign</button>
            </div>
          )}
          {creating ? (
            canAssign && assignMode === "assign" ? (
              <div className="tp2-people" role="group" aria-label="Assign to">
                <button type="button" disabled={ro} className={"tp2-person" + (!cur.editor_id ? " on" : "")} onClick={() => set("editor_id", "editorId", null)}>
                  <span className="tb-ava init none">–</span>Unassigned
                </button>
                {assignPeople.map((ed) => (
                  <button key={ed.id} type="button" disabled={ro} className={"tp2-person" + (cur.editor_id === ed.id ? " on" : "")} onClick={() => set("editor_id", "editorId", ed.id)}>
                    <Ava name={ed.name} image={ed.image_url} size={24} />{ed.name}
                  </button>
                ))}
              </div>
            ) : selfChip
          ) : canTake ? (
            /* Nobody has this task yet — anyone on the team can take it. */
            <button type="button" className="btn btn-sm" onClick={() => patch({ editorId: user!.editorId })}>🙋 Take this task</button>
          ) : (
            <select className="t" disabled={!canReassign} value={cur.editor_id ?? ""} onChange={(e) => set("editor_id", "editorId", e.target.value || null)}>
              <option value="">Unassigned</option>
              {assignPeople.map((ed) => (<option key={ed.id} value={ed.id}>{ed.name}</option>))}
            </select>
          )}
        </>
      )}
    </Row>
  );
  const startRow = isProject && (
    <Row label="Start Date" icon={ic(TB_ICON.event)}>
      <input className="t tp2-date" type="date" disabled={briefRo} value={cur.start_date ?? ""} onChange={(e) => set("start_date", "startDate", e.target.value || null)} />
    </Row>
  );
  const dueRow = (
    <Row label="Due Date" icon={ic(TB_ICON.event)}>
      <div className="tp2-inline">
        <input className="t tp2-date" type="date" disabled={briefRo} value={cur.due_date ?? ""}
          min={isProject ? (cur.start_date ?? undefined) : undefined} max={dueMax}
          onChange={(e) => set("due_date", "dueDate", e.target.value || null)} />
        {creating && !isProject && !briefRo && quickDues().map((q) => (
          <button key={q.value} type="button" className={"tp2-pill" + (cur.due_date === q.value ? " on" : "")} onClick={() => set("due_date", "dueDate", q.value)}>{q.label}</button>
        ))}
        {!creating && task!.due_date && <span className={"tp2-faint" + (overdueEdit ? " bad" : "")}>{dueLabel(task!.due_date)}</span>}
      </div>
      {isProject && projectDuration != null && (
        <span className="hint" style={{ display: "block", marginTop: 4 }}>Within {projectDuration} day{projectDuration === 1 ? "" : "s"} of the Start Date{dueMax ? ` (by ${dueMax})` : ""}.</span>
      )}
    </Row>
  );
  const brandRow = (
    <Row label="Brand" icon={ic(TB_ICON.tag)}>
      <select className="t tp2-narrow" disabled={briefRo} value={cur.channel_id ?? ""} onChange={(e) => set("channel_id", "channelId", e.target.value || null)}>
        <option value="">—</option>
        {channels.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
      </select>
    </Row>
  );
  // Ads: the team it's made for instead of a brand (an older Ad task keeps showing its brand too)
  const teamRow = (
    <Row label="Team" icon={ic(TB_ICON.tag)}>
      <select className="t tp2-narrow" disabled={briefRo} value={cur.ad_team_id ?? ""} aria-label="Team this ad is for"
        onChange={(e) => set("ad_team_id", "adTeamId", e.target.value || null)}>
        <option value="">—</option>
        {(adTeams ?? []).concat(task?.ad_team_id && !(adTeams ?? []).some((x) => x.id === task.ad_team_id)
          ? [{ id: task.ad_team_id, name: task.ad_team_name ?? "Team", leadName: "", active: false, tasks: 0 }] : [])
          .map((x) => <option key={x.id} value={x.id}>{x.name}{x.leadName ? ` · ${x.leadName}` : ""}</option>)}
      </select>
    </Row>
  );
  const placeRow = adByTeam ? <>{teamRow}{!creating && cur.channel_id ? brandRow : null}</> : brandRow;
  const priorityRow = (
    <Row label="Priority" icon={ic(TB_ICON.flag)}>
      {creating ? (
        <div className="tp2-chips" role="group" aria-label="Priority">
          {(["low", "medium", "high"] as const).map((p) => (
            <button key={p} type="button" disabled={briefRo} className={"tp2-chip pri-" + p + (cur.priority === p ? " on" : "")} onClick={() => set("priority", "priority", p)}>
              <span className="tp2-chip-ic">{p === "high" ? "!" : p === "low" ? "↓" : "="}</span>{PRI_LABEL[p]}
            </button>
          ))}
        </div>
      ) : (
        <select className="t tp2-narrow" disabled={briefRo} value={cur.priority} onChange={(e) => set("priority", "priority", e.target.value)}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
      )}
    </Row>
  );
  const typeRow = !(adminTask || adminEdit) && (
    <Row label={isProject ? "Project type" : "Content Type"} icon={ic(TB_ICON.category)}>
      {/* Always a dropdown; its options are the content/project types
          configured in Task Settings for the active category. */}
      <select className="t tp2-narrow" disabled={briefRo} value={cur.content_format_id ?? ""} onChange={(e) => onPickContentType(e.target.value || null)}>
        <option value="">—</option>
        {typeChoices.map((f) => (<option key={f.id} value={f.id}>{f.icon} {f.name}{!activeCategory ? ` · ${CATEGORY_LABEL[f.category ?? "social"]}` : ""}</option>))}
      </select>
      {limitTypes && !briefRo && (
        <span className="hint" style={{ display: "block", marginTop: 4 }}>
          {typeChoices.length ? `For someone else you can pick only ${limitNames}.` : `For someone else you can pick only ${limitNames}, which isn't in this category.`}
        </span>
      )}
    </Row>
  );
  /* Whoever assigns work decides if this task needs its output linked before
     review; everyone else just sees the answer. */
  const linkRow = !(adminTask || adminEdit) && (canAssign || !creating) && (
    <Row label="Review link" icon={ic(TB_ICON.link)}>
      <label className={"tp-linkreq tp2-switch" + (linkRequired ? " on" : "")}>
        <input
          type="checkbox"
          checked={linkRequired}
          disabled={ro || !canSetLink || (isDoneTask && !isAdmin)}
          onChange={(e) => (creating ? setLinkOverride(e.target.checked) : patch({ reviewLinkRequired: e.target.checked }))}
        />
        <span className="tp2-track" aria-hidden="true"><span /></span>
        <span>Required to submit for review</span>
      </label>
    </Row>
  );
  const pointsRow = isProject && (
    <Row label="Points" icon={ic(TB_ICON.star)}>
      <div className="t autofield">{projectPoints != null ? projectPoints : "— pick a project type first"}</div>
    </Row>
  );
  // A task given to someone: which team asked for it, and how long it should
  // take. When it isn't in their goals, that time comes off their goal once
  // it's done (server/src/goal-score.js), so only whoever gives it sets these.
  const givenToOther = creating ? !!draft.editor_id && draft.editor_id !== user?.editorId : !!task?.assigned_by;
  const otherRows = givenToOther && !(adminTask || adminEdit) && (
    <>
      <Row label="Requested by" icon={ic(TB_ICON.person)}>
        <input className="t" placeholder="Which team asked, e.g. Longer Life" maxLength={80} disabled={briefRo}
          value={creating ? draft.requested_by : askedBy}
          onChange={(e) => (creating ? setDraft((d) => ({ ...d, requested_by: e.target.value })) : setAskedBy(e.target.value))}
          onBlur={() => { if (!creating && askedBy.trim() !== (task?.meta?.requestedBy ?? "")) patch({ requestedBy: askedBy.trim() || null }); }} />
      </Row>
      <Row label="Should take" icon={ic(TB_ICON.hourglass)}>
        <span className="tp2-hours">
          <input className="t tp2-narrow" type="number" min={0.25} max={200} step={0.25} placeholder="Usual" disabled={briefRo} aria-label="Hours it should take"
            value={creating ? (draft.budget_hours ?? "") : shouldTake}
            onChange={(e) => (creating
              ? setDraft((d) => ({ ...d, budget_hours: e.target.value === "" ? null : Number(e.target.value) }))
              : setShouldTake(e.target.value))}
            onBlur={() => {
              if (creating) return;
              const v = shouldTake === "" ? null : Number(shouldTake);
              if (v !== (task?.budget_hours ?? null) && (v == null || (v >= 0.25 && v <= 200))) patch({ budgetHours: v });
            }} />
          <small>hours · if it isn't in their goals, this time comes off their goal</small>
        </span>
      </Row>
    </>
  );
  const repeatRow = !creating && !adminEdit && (
    <Row label="Repeat" icon={TB_ICON.repeat}>
      <select className="t tp2-narrow" disabled={briefRo} value={task!.recurrence} onChange={(e) => patch({ recurrence: e.target.value })}>
        <option value="none">Doesn't repeat</option><option value="daily">🔁 Daily</option><option value="weekly">🔁 Weekly</option>
      </select>
    </Row>
  );

  if (creating) {
    // What the person this is for gets out of it (GET /goals/preview): goal
    // points for a type in their goals, or — given to them, outside their
    // goals — the time it takes off their goal (server/src/goal-score.js rule 6).
    const forMe = !!cur.editor_id && cur.editor_id === user?.editorId;
    const forName = forMe ? "your" : `${editors.find((e) => e.id === cur.editor_id)?.name ?? "their"}'s`;
    const shouldTake = draft.budget_hours ?? selectedFormat?.hours ?? null;
    const pv = preview;
    let tag: "goal" | "other" | "none" | null = null, big = "", line = "";
    let after: number | null = null;
    if (!category) line = "Pick what kind of work this is to see how it scores.";
    else if (adminTask) { tag = "none"; big = "No points"; line = "General tasks don't count toward goals. No review: you close it yourself with Done."; }
    else if (!cur.editor_id) { tag = "none"; big = "Not given yet"; line = "Whoever takes it gets its points, if its type is in their goals."; }
    else if (!cur.content_format_id && !otherPick) line = `Pick its type to see what it adds to ${forName} month.`;
    else if (previewBusy && !pv) line = "Working it out…";
    else if (!pv || !(pv.goalPoints > 0)) { tag = "none"; big = "No goal yet"; line = `${forMe ? "You have" : `${forName.replace(/'s$/, "")} has`} no goals set this month, so it won't add points yet.`; }
    else if (pv.inGoal) {
      tag = "goal"; big = `+${tenths(pv.points ?? 0)} pts`;
      line = `Counts toward ${forName} ${pv.typeName} goal${pv.typeGoal ? `: ${tenths(pv.typeGoal.done)} of ${tenths(pv.typeGoal.goal)} done so far` : ""}.`;
      after = ((pv.reached + (pv.points ?? 0)) / pv.goalPoints) * 100;
    } else if (givenToOther) {
      tag = "other"; big = shouldTake ? `−${tenths(shouldTake)}h off the goal` : "Set how long it should take";
      line = `Not in ${forName} goals this month. Once it's done, the time it took${shouldTake ? ` (up to ${tenths(shouldTake)}h)` : ""} comes off their goal, so they stay on track.`;
      const left = pv.timeFactor - (shouldTake ?? 0) / Math.max(1, pv.monthHours);
      after = left > 0 && pv.timeFactor > 0 ? (pv.reached / (pv.goalPoints * (left / pv.timeFactor))) * 100 : null;
    } else if (selectedFormat && selectedFormat.counts_in_goal !== false) {
      tag = "none"; big = "No points";
      line = `${selectedFormat.name} counts in goals, but your goal this month has no ${selectedFormat.name} jobs, so it won't add points. Your lead can add some on Set goals.`;
    } else { tag = "none"; big = "No points"; line = "Not in your goals this month, so it won't add points. (Work someone gives you does take time off your goal.)"; }
    const now = pv && pv.goalPoints > 0 ? (pv.reached / pv.goalPoints) * 100 : null;
    // General is for a Manager, Asst. Manager or Team Lead (by their position; the server holds the same line)
    const meRow = editors.find((e) => e.id === user?.editorId) ?? null;
    const makesGeneral = homeRoleOf(meRow?.designation, isAdmin) !== "editor";
    const kinds = KINDS.filter((k) => !k.leadsOnly || makesGeneral);
    const hint = dayLocked ? "Start your day first: tap Start day above."
      : !category ? "Choose what kind of work this is to begin."
      : !title.trim() ? "Give the task a title."
      : elseNeedsBrief ? "Say what the work is in the Brief — Something else has no type to tell them."
      : adminNeedsRoster ? "You're not on the team roster yet, so a General task would have no owner. Add yourself on Team › Roster first."
      : !adminTask && adByTeam && !draft.ad_team_id ? "Pick the team this ad is for — Ads are numbered per team."
      : !adminTask && !adByTeam && !draft.channel_id ? "Pick a brand — its tasks are numbered per brand."
      : category === "project" && contentTypeChoices.length === 0 ? "No project types yet. Add one under Settings › Tasks & time first."
      : category === "project" && !draft.content_format_id ? "Pick a project type."
      : limitTypes && !draft.content_format_id ? `Pick a type. You can give others only ${limitNames} tasks.`
      : nextRef ? `Ready — ${nextRef} will be assigned when you create it.` : "Ready to create.";
    return (
      <div className={"task-panel-scrim center tp2-scrim" + (leaving ? " leaving" : "")} onClick={close}>
        <div className={"task-panel centered tp2 tp2-sheet tp2-new" + (leaving ? " leaving" : "")} role="dialog" aria-label="New task" onClick={(e) => e.stopPropagation()}>
          <div className="tp2-grab" aria-hidden="true"><span /></div>
          <div className="tp2-nhead">
            <input className={"tp2-ntitle" + (title.trim() ? " filled" : "")} autoFocus placeholder="What needs doing?" value={title} maxLength={300}
              onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
            {nextRef && <span className="tp2-refchip" title="The number it gets when you create it">{nextRef}</span>}
            <button type="button" className="tp2-x" onClick={close} aria-label="Close">{TB_ICON.close}</button>
          </div>
          <div className="tp2-nbody">
            <div className="tp2-nform">
              {dayLocked && (
                <div className="tp2-dayask" role="status">
                  <span><b>Your day hasn't started.</b> Start it to create this task. Its timer and points count from then.</span>
                  <button type="button" className="tp2-btn pri" disabled={dayBusy} onClick={() => { startDay().catch(() => {}); }}>
                    {dayBusy ? "Starting…" : "▶ Start day"}
                  </button>
                </div>
              )}

              <section className="tp2-sec">
                <h3><span>1</span>What kind of work</h3>
                <div className={"tp2-kinds" + (category ? " picked" : "")} role="group" aria-label="Category">
                  {kinds.map((k) => (
                    <button key={k.k} type="button" className={"tp2-kind" + (category === k.k ? " on" : "")} aria-pressed={category === k.k} onClick={() => pickCategory(k.k)}>
                      <span className="tp2-kind-ic" aria-hidden="true">{k.icon}</span>
                      <b>{k.label}</b>
                      <small>{k.sub}</small>
                    </button>
                  ))}
                </div>
                {category && !adminTask && (() => {
                  // tracked in goals, or not (Settings › Tasks & time › Goal); Service also offers "Something else".
                  // Each goal type says what this person's goal still needs: "3 to go", "Goal met". For yourself only
                  // the goal types in your goal show; given to someone, one outside their goal is Other work.
                  const goalOf = new Map((goalInfo?.types ?? []).map((g) => [g.contentFormatId, g]));
                  const goalNote = (f: ContentFormatDef): { cls: string; text: string } | null => {
                    if (!goalInfo || !(goalInfo.goalPoints > 0) || f.counts_in_goal === false) return null;
                    const g = goalOf.get(f.id);
                    if (!g) return { cls: "none", text: forMe ? "No goal this month" : "Not in their goal · Other work" };
                    if (g.need > 0) return { cls: "need", text: `${g.need} to go${g.open ? ` · ${g.open} on the board` : ""}` };
                    return { cls: "met", text: g.done >= g.goal ? "Goal met" : "Rest on the board" };
                  };
                  const chip = (f: ContentFormatDef) => {
                    const note = goalNote(f);
                    return (
                      <button key={f.id} type="button" className={"tp2-type" + (f.counts_in_goal === false ? " off" : "") + (note?.cls === "need" ? " goal" : "") + (cur.content_format_id === f.id ? " on" : "")} aria-pressed={cur.content_format_id === f.id}
                        onClick={() => { setOtherPick(false); onPickContentType(cur.content_format_id === f.id ? null : f.id); }}>
                        <span>{f.icon} {f.name}</span>
                        <small>{tenths(f.points ?? 0)} {Number(f.points) === 1 ? "pt" : "pts"}{isProject ? (f.duration_days ? ` · ${f.duration_days} day${f.duration_days === 1 ? "" : "s"}` : "") : f.hours != null ? ` · ${fmtHours(Number(f.hours))}h` : ""}</small>
                        {note && <em className={"tp2-type-goal " + note.cls}>{note.text}</em>}
                      </button>
                    );
                  };
                  // what the goal still needs most comes first; the rest keep their order
                  const ask = (f: ContentFormatDef) => { const g = goalOf.get(f.id); return g && g.need > 0 ? g.need * g.points : 0; };
                  const inGoal = typeChoices.filter((f) => f.counts_in_goal !== false && (!ownGoalOnly || goalOf.has(f.id))).sort((a, b) => ask(b) - ask(a)),
                    offGoal = typeChoices.filter((f) => f.counts_in_goal === false);
                  const elsePick = category === "service" && (
                    <button type="button" className={"tp2-type off" + (otherPick ? " on" : "")} aria-pressed={otherPick}
                      onClick={() => { onPickContentType(null); setOtherPick((v) => !v); }}>
                      <span>··· Something else</span><small>say what it is in the Brief</small>
                    </button>
                  );
                  if (typeChoices.length === 0 && !elsePick) {
                    return <span className="tp2-faint">No {isProject ? "project" : CATEGORY_LABEL[category].toLowerCase()} types yet — add them under Settings › Tasks & time.</span>;
                  }
                  if (!inGoal.length && !offGoal.length && !elsePick) {
                    return <span className="tp2-faint">Your goal this month has no {isProject ? "project" : CATEGORY_LABEL[category]} work. Ask your lead if you need to make one.</span>;
                  }
                  if (!offGoal.length && !elsePick) {
                    return <div className="tp2-types" role="group" aria-label={isProject ? "Project type" : "Content type"}>{inGoal.map(chip)}</div>;
                  }
                  return (
                    <div className="tp2-typegroups">
                      {inGoal.length > 0 && (
                        <div className="tp2-typegroup">
                          <span className="tp2-typehead goal">Counts in goals</span>
                          <div className="tp2-types" role="group" aria-label="Types that count in goals">{inGoal.map(chip)}</div>
                        </div>
                      )}
                      <div className="tp2-typegroup">
                        <span className="tp2-typehead off">Off-goal · help for another team, takes its time off the goal</span>
                        <div className="tp2-types" role="group" aria-label="Off-goal types">{offGoal.map(chip)}{elsePick}</div>
                      </div>
                    </div>
                  );
                })()}
                {limitTypes && !adminTask && (
                  <span className="hint">For someone else you can pick only {limitNames}.</span>
                )}
                {givenToOther && !adminTask && (
                  <div className="tp2-given">
                    <div className="tp2-given-head">
                      <b>Given to {editors.find((e) => e.id === cur.editor_id)?.name ?? "them"}</b>
                      {pv && cur.content_format_id && !pv.inGoal && pv.goalPoints > 0 && <span className="tp2-tag other">Outside their goals</span>}
                    </div>
                    <label className="tp2-ncell">
                      <span>Requested by</span>
                      <input className="t" placeholder="Which team asked, e.g. Longer Life" maxLength={80} value={draft.requested_by}
                        onChange={(e) => setDraft((d) => ({ ...d, requested_by: e.target.value }))} />
                    </label>
                    <div className="tp2-ncell">
                      <span>Should take</span>
                      <div className="tp2-step">
                        <button type="button" aria-label="Half an hour less" onClick={() => setDraft((d) => ({ ...d, budget_hours: Math.max(0.5, (d.budget_hours ?? selectedFormat?.hours ?? 1) - 0.5) }))}>−</button>
                        <b>{shouldTake != null ? `${tenths(shouldTake)}h` : "—"}</b>
                        <button type="button" aria-label="Half an hour more" onClick={() => setDraft((d) => ({ ...d, budget_hours: Math.min(200, (d.budget_hours ?? selectedFormat?.hours ?? 0) + 0.5) }))}>+</button>
                        {[1, 3, 8].map((h) => (
                          <button key={h} type="button" className={"tp2-pill" + (shouldTake === h ? " on" : "")} onClick={() => setDraft((d) => ({ ...d, budget_hours: h }))}>{h}h</button>
                        ))}
                      </div>
                      <small className="tp2-faint">Becomes its time budget{selectedFormat?.hours != null && draft.budget_hours == null ? ` (its type's usual ${fmtHours(Number(selectedFormat.hours))}h)` : ""}.</small>
                    </div>
                  </div>
                )}
              </section>

              <section className="tp2-sec">
                <h3><span>2</span>Details</h3>
                <div className="tp2-ngrid">
                  {!adminTask && (
                    <label className="tp2-ncell">
                      <span>{adByTeam ? "Team" : "Brand"}</span>
                      {adByTeam ? (
                        <select className="t" value={draft.ad_team_id ?? ""} aria-label="Team this ad is for" onChange={(e) => setDraft((d) => ({ ...d, ad_team_id: e.target.value || null }))}>
                          <option value="">Pick a team</option>
                          {(adTeams ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.leadName ? ` · ${x.leadName}` : ""}</option>)}
                        </select>
                      ) : (
                        <select className="t" value={draft.channel_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, channel_id: e.target.value || null }))}>
                          <option value="">Pick a brand</option>
                          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                    </label>
                  )}
                  <div className="tp2-ncell">
                    <span>Assignee</span>
                    {adminTask ? selfChip : (
                      <>
                        {canSelfAssign && canAssign && (
                          <div className="tp2-segs" role="group" aria-label="Who it's for">
                            <button type="button" className={assignMode === "self" ? "on" : ""} onClick={() => setMode("self")}>Myself</button>
                            <button type="button" className={assignMode === "assign" ? "on" : ""} onClick={() => setMode("assign")}>Assign</button>
                          </div>
                        )}
                        {canAssign && assignMode === "assign" ? (
                          <div className="tp2-people" role="group" aria-label="Assign to">
                            <button type="button" className={"tp2-person" + (!cur.editor_id ? " on" : "")} onClick={() => setDraft((d) => ({ ...d, editor_id: null }))}>
                              <span className="tb-ava init none">–</span>Unassigned
                            </button>
                            {assignPeople.map((ed) => (
                              <button key={ed.id} type="button" className={"tp2-person" + (cur.editor_id === ed.id ? " on" : "")} onClick={() => setDraft((d) => ({ ...d, editor_id: ed.id }))}>
                                <Ava name={ed.name} image={ed.image_url} size={24} />{ed.name}
                              </button>
                            ))}
                          </div>
                        ) : (!canAssign || assignMode === "self") && selfChip}
                      </>
                    )}
                  </div>
                  {isProject && (
                    <label className="tp2-ncell">
                      <span>Start date</span>
                      <input className="t tp2-date" type="date" value={cur.start_date ?? ""} onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value || null }))} />
                    </label>
                  )}
                  <div className="tp2-ncell">
                    <span>Due</span>
                    {!isProject && (
                      <div className="tp2-inline">
                        {workDues(org?.calendar).map((q) => (
                          <button key={q.value} type="button" className={"tp2-pill" + (cur.due_date === q.value ? " on" : "")} onClick={() => setDraft((d) => ({ ...d, due_date: d.due_date === q.value ? null : q.value }))}>{q.label}</button>
                        ))}
                      </div>
                    )}
                    <input className="t tp2-date" type="date" value={cur.due_date ?? ""} aria-label="Due date"
                      min={isProject ? (cur.start_date ?? undefined) : undefined} max={dueMax}
                      onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value || null }))} />
                    {isProject && projectDuration != null && <small className="tp2-faint">Within {projectDuration} day{projectDuration === 1 ? "" : "s"} of the start{dueMax ? ` (by ${dueMax})` : ""}.</small>}
                  </div>
                  <div className="tp2-ncell">
                    <span>Priority</span>
                    <div className="tp2-segs" role="group" aria-label="Priority">
                      {(["low", "medium", "high"] as const).map((p) => (
                        <button key={p} type="button" className={"pri-" + p + (cur.priority === p ? " on" : "")} onClick={() => setDraft((d) => ({ ...d, priority: p }))}>{PRI_LABEL[p]}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="tp2-sec">
                <h3><span>3</span>{adminTask ? "Brief" : "Brief & links"}{otherPick && <em className={"tp2-req" + (elseNeedsBrief ? "" : " ok")}>{elseNeedsBrief ? "Required · say what the work is" : "✓ Says what the work is"}</em>}</h3>
                <textarea className={"tp-desc tp2-desc" + (elseNeedsBrief ? " need" : "")} value={description} maxLength={20000} onChange={(e) => setDescription(e.target.value)}
                  placeholder={otherPick ? "What is this work? e.g. Pack shots for the Diwali hamper: 6 photos on white, for the Longer Life team" : "What does done look like? Anything they need to know…"} />
                {!adminTask && <Attachments links={cur.attachments} readOnly={false} onChange={(next) => setDraft((d) => ({ ...d, attachments: next }))} />}
                {!adminTask && canAssign && (
                  <label className={"tp-linkreq tp2-switch" + (linkRequired ? " on" : "")}>
                    <input type="checkbox" checked={linkRequired} onChange={(e) => setLinkOverride(e.target.checked)} />
                    <span className="tp2-track" aria-hidden="true"><span /></span>
                    <span>Review link required to submit for review</span>
                  </label>
                )}
              </section>
            </div>

            <aside className="tp2-score" aria-live="polite">
              <b className="tp2-score-h">How it scores</b>
              {tag && <span className={"tp2-tag " + tag}>{tag === "goal" ? "Goal" : tag === "other" ? "Other work" : "No points"}</span>}
              {big && <span className={"tp2-score-big " + (tag ?? "")}>{big}</span>}
              <span className="tp2-score-line">{line}</span>
              {now != null && (
                <div className="tp2-month">
                  <span className="tp2-month-l">{forMe ? "Your" : forName.replace(/'s$/, "") + "'s"} month</span>
                  <div className="tp2-month-bar">
                    <span className="done" style={{ width: `${Math.min(100, now)}%` }} />
                    {after != null && after > now && <span className="this" style={{ width: `${Math.max(0, Math.min(100, after) - Math.min(100, now))}%` }} />}
                  </div>
                  <span className="tp2-month-n">
                    {Math.round(now)}% of the goal{after != null && Math.round(after) !== Math.round(now) ? <> → <b>{Math.round(Math.min(150, after))}%</b> with this task</> : ""}
                  </span>
                  {(pv?.otherHours ?? 0) > 0 && <small className="tp2-faint">Already {tenths(pv!.otherHours)}h of Other work this month.</small>}
                </div>
              )}
            </aside>
          </div>
          <div className="tp2-foot">
            <span className={"tp2-foot-hint" + (canCreate ? " ok" : "")}>{canCreate ? TB_ICON.check : TB_ICON.info}<span>{hint}</span></span>
            <button type="button" className="tp2-btn" onClick={close}>Cancel</button>
            <button type="button" className="tp2-btn pri" disabled={busy || !canCreate} onClick={create}>{TB_ICON.plus} {busy ? "Creating…" : "Create task"}</button>
          </div>
        </div>
      </div>
    );
  }

  const t = task!;
  return (
    <div className={"task-panel-scrim tp2-scrim" + (leaving ? " leaving" : "")} onClick={close}>
      <aside className={"task-panel tp2 tp2-drawer" + (leaving ? " leaving" : "")} aria-label={t.title} onClick={(e) => e.stopPropagation()}>
        <div className="tp2-dhead">
          {/* Shrinks (and clips) before the buttons on the right ever do. */}
          <span className="tp2-crumbs">
            {placeOf(t) && <><span>{placeOf(t)}</span><span>/</span></>}
            <span className="tp2-mono strong">{ref}</span>
            {otherIds.map((id) => <span key={id} className="tp2-mono">· {id}</span>)}
            {editCategory && <span className="tp2-tag">{CATEGORY_LABEL[editCategory]}</span>}
            {t.self_created && <span className="self-chip" title="The assignee created this task for themselves">🙋 Self-created</span>}
          </span>
          {!ro && onDelete && <button type="button" className="tp2-hbtn" onClick={() => onDelete(t)}>🗑 Delete</button>}
          <button type="button" className="tp2-x" onClick={close} aria-label="Close">{TB_ICON.close}</button>
        </div>
        <div className="tp-body tp2-body">
          {/* In review, the output is the first thing a reviewer needs. */}
          {t.status === "review" && (
            t.delivery_link ? (
              <a className="btn btn-primary tp-work" href={t.delivery_link} target="_blank" rel="noopener noreferrer">
                🔗 Open the work
              </a>
            ) : (
              <div className="hint tp-nowork">
                {t.link_required ? "⚠️ No work is attached to this task." : "No link is needed for this task."}
              </div>
            )
          )}
          {t.pending_note && (
            <div className="task-rework-note" title={t.pending_note}>
              {TB_ICON.note}<span>Rework: {t.pending_note}</span>
            </div>
          )}
          {/* Hand over your own task, answer one offered to you, or move one on */}
          <HandoverBlock task={t} onChanged={onChanged} />
          {/* approved social work: its scheduler sets the date and pastes the links */}
          {t.schedule_from && <ScheduleBlock task={t} editors={editors} onChanged={onChanged} />}
          {/* approved Ad work: the Managers and Team Leads record the ads it became */}
          {t.upload_from && <AdUploadBlock task={t} onChanged={onChanged} />}
          {/* approved R&D work (AI Job): what it becomes, a Reel, an Ad, both or not used */}
          {t.task_type === "service" && t.status === "done" && (t.meta?.use || selectedFormat?.to_scheduling) && (
            <RndUseBlock task={t} formats={contentFormats ?? []} people={canAssign ? assignPeople : assignPeople.filter((e) => e.id === user?.editorId)}
              channels={channels} adTeams={adTeams ?? []} canDecide={decidesRnd} onChanged={onChanged} />
          )}
          {t.meta?.fromTask && (
            <div className="hint tp-from">🧪 Made from <b>{t.meta.fromTask.ref}</b> · {t.meta.fromTask.title}</div>
          )}
          {!ro && briefRo && (
            <div className="hint tp-locked">
              🔒 {isDoneTask ? "This task is completed — only an admin can change it."
                : isOwnerTask ? "This task was assigned to you. You can add your work link, checklist and comments; only an admin can change its details."
                : "Only an admin can change this task. You can still comment on it."}
            </div>
          )}
          <input className="tp-title tp2-dtitle" placeholder="Task title…" value={title} maxLength={300} disabled={briefRo}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() && title !== t.title) patch({ title: title.trim() }); }} />
          <textarea className="tp-desc tp2-desc" placeholder="Add a description…" value={description} maxLength={20000} disabled={briefRo}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => { if (description !== (t.description ?? "")) patch({ description }); }} />
          <div className="tp-fields tp2-props">
            {statusRow}
            {assigneeRow}
            {startRow}
            {dueRow}
            {otherRows}
            {placeRow}
            {priorityRow}
            {typeRow}
            {linkRow}
            {repeatRow}
            {pointsRow}
          </div>
          {t.budget_hours != null && <TimerCard t={t} />}
          {!adminEdit && (
            <Attachments links={cur.attachments} readOnly={!canEditWork} onChange={(next) => set("attachments", "attachments", next)} />
          )}
          {!t.post_id && canEditWork && <LinkPostControl taskId={t.id} onLinked={onChanged} />}
          <Checklist taskId={t.id} readOnly={!canEditWork} onChanged={onChanged} />
          {!adminEdit && <DeliveryLink task={t} canEdit={canEditDelivery} onChanged={onChanged} />}
          <ReviewHistory taskId={t.id} />
          <TaskHistory taskId={t.id} title={t.title} />
          <Comments taskId={t.id} readOnly={ro} />
        </div>
        {canResolve ? (
          <div className={"tp2-dfoot tp2-review" + (backOpen ? " open" : "")}>
            {backOpen ? (
              <>
                <textarea className="tp2-backnote" rows={2} autoFocus maxLength={2000} value={backNote}
                  placeholder={`What does ${t.editor_name ?? "the editor"} need to fix before sending it again?`} aria-label="What needs fixing"
                  onChange={(e) => setBackNote(e.target.value)} />
                <div className="tp2-review-acts">
                  <button type="button" className="btn" onClick={() => { setBackOpen(false); setBackNote(""); }}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={resolving || !backNote.trim()} onClick={sendBack}>
                    {resolving ? "Sending…" : "Send back"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="tp2-review-say">{TB_ICON.info}<span>Reviewed the work? Approve it, or send it back with a note.</span></span>
                <div className="tp2-review-acts">
                  <button type="button" className="btn" disabled={resolving} onClick={() => setBackOpen(true)}>↩ Send back</button>
                  <button type="button" className="btn btn-primary" disabled={resolving} onClick={approve}>{resolving ? "Approving…" : "✓ Approve"}</button>
                </div>
              </>
            )}
          </div>
        ) : rule && <div className="tp2-dfoot">{TB_ICON.info}<span>{rule}</span></div>}
      </aside>
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
          {!readOnly && (
            <button type="button" className="tp-link-x" title="Remove link" aria-label={`Remove ${a.label || a.url}`}
              onClick={() => onChange(links.filter((_, j) => j !== i))}>✕</button>
          )}
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
          <input className="t" placeholder="Add checklist item…" value={newTitle} maxLength={300} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button type="button" className="btn" onClick={add} disabled={!newTitle.trim()}>Add</button>
        </div>
      )}
    </div>
  );
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Delivery Link — the URL of the completed deliverable, shown directly below the
// checklist. Empty state (for someone who can edit) is an input + Save; once set
// it's a clickable link + Edit. Read-only viewers see the link if present, or
// nothing when empty. Admin tasks never render this (handled by the caller).
function DeliveryLink({ task, canEdit, onChanged }: { task: Task; canEdit: boolean; onChanged?: () => void }) {
  const [saved, setSaved] = useState(task.delivery_link ?? "");
  const [value, setValue] = useState(task.delivery_link ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    const v = value.trim();
    if (v && !isValidHttpUrl(v)) {
      toast.error("Enter a valid link starting with http:// or https://");
      return;
    }
    setBusy(true);
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ deliveryLink: v || null }) });
      setSaved(v);
      setEditing(false);
      onChanged?.();
      toast.success(v ? "Delivery link saved." : "Delivery link cleared.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the delivery link.");
    } finally {
      setBusy(false);
    }
  }

  // Read-only: show the link if there is one, otherwise render nothing.
  if (!canEdit) {
    if (!saved) return null;
    return (
      <div className="field">
        <label className="f">Delivery Link</label>
        <a className="delivery-link" href={saved} target="_blank" rel="noopener noreferrer">🔗 {saved}</a>
      </div>
    );
  }

  const showInput = editing || !saved;
  return (
    <div className="field">
      <label className="f">Delivery Link</label>
      {showInput ? (
        <div className="chk-add">
          <input
            className="t"
            type="url"
            placeholder="https://… link to the delivered asset"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
          />
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          {saved && <button type="button" className="btn" onClick={() => { setValue(saved); setEditing(false); }}>Cancel</button>}
        </div>
      ) : (
        <div className="delivery-row">
          <a className="delivery-link" href={saved} target="_blank" rel="noopener noreferrer">🔗 {saved}</a>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
        </div>
      )}
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

// Everything that happened to the task, oldest first: who created it and for
// whom, who it was assigned to, who accepted, every hand-over and its answer,
// reviews. Read from the activity log (GET /tasks/:id/history).
type HistoryEntry = { id: string; verb: string; summary: string; created_at: string; actor_id: string | null; actor_name: string | null };
const HISTORY_ICON: Record<string, string> = {
  created: "✨", assigned: "👤", accepted: "👍", review_requested: "📤", sent_back: "↩️", completed: "🎉", reopened: "🔄",
  held: "⏸", resumed: "▶️", handover_offered: "🔁", handover_accepted: "🤝", handover_declined: "✋", handover_cancelled: "↩️",
  handover_escalated: "⚠️", handover_moved: "🔁", commented: "💬",
};
function TaskHistory({ taskId, title }: { taskId: string; title: string }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let cancel = false;
    const load = () => api<{ history: HistoryEntry[] }>(`/tasks/${taskId}/history`)
      .then((d) => { if (!cancel) setItems(d.history); })
      .catch(() => { if (!cancel) setItems([]); });
    load();
    const off = onTasksChanged(load);
    return () => { cancel = true; off(); };
  }, [taskId]);
  const rows = (items ?? []).filter((h) => h.verb !== "commented");
  if (rows.length === 0) return null;
  // The task's own name reads as "this task" here.
  const tidy = (s: string) => s.split(`task “${title}”`).join("this task").split(`“${title}”`).join("this task");
  const line = (h: HistoryEntry) => {
    const s = tidy(h.summary);
    return h.actor_id ? `${h.actor_name ?? "Someone"} ${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;
  };
  const shown = all || rows.length <= 6 ? rows : rows.slice(-6);
  return (
    <div className="field">
      <label className="f">History</label>
      <ol className="tp-history">
        {!all && rows.length > 6 && (
          <li className="tp-history-more"><button type="button" onClick={() => setAll(true)}>Show all {rows.length} steps</button></li>
        )}
        {shown.map((h) => (
          <li key={h.id}>
            <span className="tp-history-ic" aria-hidden="true">{HISTORY_ICON[h.verb] ?? "•"}</span>
            <span className="tp-history-tx">{line(h)}</span>
            <span className="tp-history-at">{dateTime(h.created_at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Comments({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
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
      {!readOnly && (
        <div className="cmt-add">
          <input className="t" placeholder="Write a comment…" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }} />
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !text.trim()}>Post</button>
        </div>
      )}
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

// List view, as in the redesign: one group per status (click a group to fold
// it), the task's number first, then who, brand, priority, due and its clock.
// Search / sort / team filter already apply upstream, so each group keeps the
// chosen sort; clicking a row opens the detail panel.
function TaskList({ tasks, onOpen, nowMs }: { tasks: Task[]; onOpen: (t: Task) => void; nowMs: number }) {
  const [shut, setShut] = useState<Partial<Record<TaskStatus, boolean>>>({});
  const groups = COLUMNS.map((c) => ({ ...c, rows: tasks.filter((t) => t.status === c.key) })).filter((g) => g.rows.length > 0);
  return (
    <div className="tb-list">
      <div className="tb-list-scroll">
        <div className="tb-list-inner">
          <div className="tb-lrow tb-lhead" aria-hidden="true">
            <span>ID</span><span>Title</span><span>Assignee</span><span>Brand</span><span>Priority</span><span>Due</span><span>Checklist</span><span className="r">Time</span>
          </div>
          {groups.map((g) => (
            <div key={g.key} className="tb-lgroup">
              <button type="button" className={"tb-lgroup-head" + (shut[g.key] ? " shut" : "")} aria-expanded={!shut[g.key]}
                onClick={() => setShut((s) => ({ ...s, [g.key]: !s[g.key] }))}>
                {TB_ICON.chevron}<span className={"tdot " + g.key} />{g.label}<span className="tb-lcount">{g.rows.length}</span>
              </button>
              {!shut[g.key] && g.rows.map((t) => {
                const overdue = t.status !== "done" && !!t.due_date && t.due_date < today();
                const wait = t.status === "review" && t.review_started_at ? reviewWaitMs(t, nowMs) : null;
                return (
                  <div key={t.id} className="tb-lrow" role="button" tabIndex={0} onClick={() => onOpen(t)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(t); } }}>
                    <span className="tb-ref" title={t.tid ?? undefined}>{taskRef(t)}</span>
                    <span className="tb-ltitle">
                      <b>{t.title}</b>
                      {t.revision > 1 && <span className="tb-rev">Rev {t.revision}</span>}
                      {t.on_hold && <span className="task-hold-badge">{TB_ICON.hold} On hold</span>}
                      {wait != null && <span className={"tb-lwait" + (wait >= SLOW_REVIEW_MS ? " slow" : "")}>{TB_ICON.hourglass} {fmtWait(wait)}</span>}
                      {(t.content_format_name || t.content_type) && (
                        <span className="tb-tag">{t.content_format_name ? `${t.content_format_icon ?? ""} ${t.content_format_name}` : CONTENT_LABEL(t.content_type)}</span>
                      )}
                      {t.platforms?.length > 0 && <span className="task-plats">{t.platforms.map((p) => PLATFORM_META[p]?.icon ?? "").join(" ")}</span>}
                    </span>
                    <span className="tb-lwho">{t.editor_name ? <><Ava name={t.editor_name} image={t.editor_image} size={22} />{t.editor_name}</> : <span className="tb-dim">Unassigned</span>}</span>
                    <span className="tb-lbrand">{placeOf(t) ? <><span className="tb-dot" style={{ background: brandDot(placeOf(t)!) }} />{placeOf(t)}</> : <span className="tb-dim">—</span>}</span>
                    <span className={"tb-pri " + t.priority}><span className="tb-pri-dot" />{PRI_LABEL[t.priority]}</span>
                    <span className={"tb-ldue" + (overdue ? " over" : t.due_date === today() ? " today" : "")}>
                      {t.status === "done" ? "Done" : t.due_date ? dueText(t.due_date) : <span className="tb-dim">—</span>}
                    </span>
                    <span className="tb-lcheck">{t.subtask_total > 0 ? `${t.subtask_done}/${t.subtask_total}` : <span className="tb-dim">—</span>}</span>
                    <span className="r"><TaskClock t={t} nowMs={nowMs} /></span>
                  </div>
                );
              })}
            </div>
          ))}
          {tasks.length === 0 && <div className="tb-lempty">No tasks match your search or filters.</div>}
        </div>
      </div>
    </div>
  );
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
  return clockTimeShort(new Date(2000, 0, 1, h, m));
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
