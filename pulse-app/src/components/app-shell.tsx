import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { NAV_ITEMS, PAGE_META, type NavItem } from "@/lib/nav";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { api } from "@/lib/api";
import { whileVisible } from "@/lib/visible-poll";
import { useTaskAlertList } from "@/lib/use-task-alerts";
import { useAutoSync } from "@/lib/auto-sync";
import { getActivitySeen, markActivitySeen, onActivitySeenChange } from "@/lib/activity-seen";
import { NotifyPanel } from "@/components/notify-panel";
import { useInbox } from "@/lib/use-inbox";
import { LeavePanel } from "@/pages/leave";
import { Icon } from "@/components/icon";
import { hasSeenTask, useTaskAssignNotify } from "@/lib/use-task-notify";
import { useDueOverdueNotify, useOverdueTaskNotify, useReviewWaitingNotify } from "@/lib/use-overdue-notify";
import { useReviewAccess } from "@/lib/use-review-access";
import { useOrg } from "@/lib/use-org";
import { homeRoleOf, seesTeamAttendance } from "@/lib/home-role";
import { setWeekStart } from "@/lib/date-range";
import { ViewAsBar, ViewAsModal } from "@/components/view-as";
import { TaskPanel } from "@/pages/tasks";
import { BreakWidget } from "@/components/break-widget";
import { BreakOverlay } from "@/components/break-overlay";
import { BreakProvider, useBreakState } from "@/lib/break-context";
import { useDayLocked, useEodState } from "@/lib/eod-context";
import { MyProfileModal } from "@/components/my-profile-modal";
import { Modal } from "@/components/modal";
import { ErrorBoundary } from "@/components/error-boundary";
import { notifyTasksChanged } from "@/lib/task-events";
import { SodModal } from "@/components/sod-modal";
import { useTheme, ACCENTS } from "@/components/theme-provider";
import { ChatProvider, useChat } from "@/lib/chat";
import { OnlineNow } from "@/components/online-now";
import { EchoMark } from "@/components/echo-logo";
import { navIcon, SIGN_OUT_ICON, RAIL_ICON, COMPOSE_ICON, SEARCH_ICON, PLUS_ICON, BREAK_ICON, GEAR_ICON, MORE_ICON, CLOSE_ICON } from "@/components/nav-icons";
import { JumpPalette, type JumpItem } from "@/components/jump-palette";
import "./sidebar.css";
import "./mobile.css";
import "./sheet.css";
import type { Activity } from "@/lib/types";

// The sidebar's groups, as in the redesign. Items still come from NAV_ITEMS
// with their own access rules; Settings lives on the gear by your name and
// Add Post on the top bar, so neither is listed. Anything new in NAV_ITEMS
// that isn't placed here lands at the end of Operations.
const SIDEBAR_GROUPS: { label: string; hrefs: string[] }[] = [
  { label: "Workspace", hrefs: ["/home", "/inbox", "/chat", "/tasks", "/analytics"] },
  { label: "Operations", hrefs: ["/metrics", "/scheduling", "/ad-uploads", "/ads-performance", "/posts", "/leaderboard", "/goals-board", "/my-team"] },
];
const OFF_SIDEBAR = new Set(["/settings", "/posts/new"]);
// Before Start Work an editor can still open these — the Workspace group, plus
// Activity and Settings (which shows only what their permissions allow). The
// Operations group (Pipeline, Posts, Leaderboard, Goals) waits for it: those
// links stay greyed, and clicking one asks them to start work.
const OPEN_WHEN_LOCKED = new Set(["/home", "/inbox", "/leave", "/activity", "/chat", "/tasks", "/analytics", "/settings", "/channels", "/task-rules"]);
const LIVE_WHEN_LOCKED = new Set(["/home", "/inbox", "/chat", "/tasks", "/analytics"]);
const openWhenLocked = (path: string) => OPEN_WHEN_LOCKED.has(path) || path.startsWith("/analytics/");
const RAIL_KEY = "pulse-sidebar-rail";
// The phone tab bar has ~54px a tab: two names go short there (the sidebar and
// page titles keep them in full).
const TAB_SHORT: Record<string, string> = { "/chat": "Chat", "/tasks": "Tasks" };

// Break time used today, for anyone whose breaks are tracked (an employee
// who's clocked in, or anyone on a break right now) — the same people the
// Task Board's break button is for. Display only; that button starts/ends it.
// Break time used today, always in view above you (as in the design): the
// bar fills as the day's 75 minutes go; on a break it turns amber. A login
// not linked to a team member has no breaks to track, and says so.
function SidebarBreak() {
  const { status, displayRemaining } = useBreakState();
  if (!status) return null;
  if (status.unlinked) {
    return (
      <div className="sb2-break off" title="Breaks are tracked for logins linked to a team member (Team › Roster).">
        {BREAK_ICON}
        <span className="sb2-label">Break</span>
        <span className="sb2-break-off sb2-label">Not tracked</span>
      </div>
    );
  }
  const cap = Math.max(60, status.dailyCapSeconds);
  const remaining = Math.min(cap, Math.max(0, displayRemaining ?? status.remainingSeconds));
  const used = cap - remaining;
  const usedMin = Math.round(used / 60), leftMin = Math.round(remaining / 60);
  return (
    <div className={"sb2-break" + (status.onBreak ? " on" : "")}
      title={status.onBreak ? `On a break: ${leftMin} min left today. Your task timers are paused.` : `${usedMin} of ${Math.round(cap / 60)} min of break used today, ${leftMin} min left`}>
      {BREAK_ICON}
      <span className="sb2-label">{status.onBreak ? "On break" : "Break"}</span>
      <span className="sb2-bar sb2-label"><span style={{ width: `${((100 * used) / cap).toFixed(1)}%` }} /></span>
      <span className="sb2-break-n sb2-label">{Math.round(used / 60)}/{Math.round(cap / 60)}m</span>
    </div>
  );
}

// Unread = activity newer than the last timestamp the user saw on /activity.
// Every half minute while the tab is in view, it asks only whether anything is
// newer than the latest notice it has (a tiny answer, nearly always "no"); the
// 40 latest are re-read only when something is.
function useUnreadActivity() {
  const { data, refetch } = useResource<{ activity: Activity[] }>("/activity?limit=40");
  const [seen, setSeen] = useState(getActivitySeen());
  const latest = useRef<Activity | undefined>(undefined);
  latest.current = data?.activity?.[0];

  useEffect(() => onActivitySeenChange(() => setSeen(getActivitySeen())), []);
  useEffect(() => whileVisible(async () => {
    try {
      const top = latest.current;
      if (top) {
        const { activity } = await api<{ activity: Activity[] }>(`/activity?limit=1&after=${encodeURIComponent(top.created_at)}`);
        if (!activity.length || activity[0].id === top.id) return; // nothing new
      }
      await refetch();
    } catch { /* the next look tries again */ }
  }, 30_000), [refetch]);

  const unread = useMemo(() => {
    const items = data?.activity ?? [];
    if (!seen) return Math.min(items.length, 9);
    return items.filter((a) => a.created_at > seen).length;
  }, [data, seen]);
  return { unread, items: data?.activity };
}

// Live notices: when someone else approves, sends back, reopens, moves, holds or
// deletes one of your tasks — or, for a reviewer, submits one — say so as it
// happens and reload every task list, instead of leaving the board on its old
// stage until the page changes. Only entries newer than this tab's first look
// count.
const LIVE_VERBS = new Set([
  "completed", "sent_back", "reopened", "assigned", "deleted", "held", "resumed",
  "review_requested", "review_copied", "password_reset_requested", "sod_submitted",
  // hand over (components/handover.tsx): offered, answered, called off, climbed, moved
  "handover_offered", "handover_accepted", "handover_declined", "handover_cancelled", "handover_escalated", "handover_moved",
]);
// Attendance notices, worded for whoever reads them: the person themselves, or
// their lead / a manager.
function attendanceNotice(a: Activity, myEditorId: string | null | undefined): string | null {
  const mine = !!myEditorId && a.entity_id === myEditorId;
  const who = a.actor_name ?? "Your lead";
  switch (a.verb) {
    case "attendance_nudge": return mine ? `${who} nudged you to start your day` : null;
    case "attendance_no_sod": return mine ? "You haven't started your day yet — tap Start day on Home" : a.summary;
    case "attendance_correction": case "attendance_late_reason":
      return mine ? null : `${who} ${a.summary.charAt(0).toLowerCase()}${a.summary.slice(1)}`;
    case "attendance_marked": case "attendance_excused": case "attendance_correction_answered": case "attendance_undone":
      return mine ? `${who} ${a.summary.charAt(0).toLowerCase()}${a.summary.slice(1)}` : null;
    default: return null;
  }
}
function useLiveNotices(items: Activity[] | undefined, myId: string | undefined, myEditorId: string | null | undefined) {
  const since = useRef<string | null>(null);
  useEffect(() => {
    if (!items) return;
    const newest = items[0]?.created_at ?? new Date().toISOString();
    if (since.current === null) { since.current = newest; return; }
    const fresh = items.filter((a) => a.created_at > since.current! && a.actor_id !== myId);
    if (newest > since.current) since.current = newest;
    if (!fresh.length) return;
    for (const a of [...fresh].reverse()) {
      // A review notice names whoever reviews it; an admin's whole-team feed
      // has everyone's, but only their own pop up.
      const reviewers = a.meta?.notifyUserIds;
      if ((a.verb === "review_requested" || a.verb === "review_copied") && Array.isArray(reviewers) && !reviewers.includes(myId)) continue;
      if (a.verb.startsWith("attendance_")) {
        const msg = attendanceNotice(a, myEditorId);
        if (msg) toast(`🔔 ${msg}`);
        continue;
      }
      if (!LIVE_VERBS.has(a.verb)) continue;
      // A task newly handed to you is announced by useTaskAssignNotify ("New
      // task"); one that comes back after you had it before is announced here.
      if (a.verb === "assigned" && myEditorId && a.meta?.toEditorId === myEditorId
          && myId && a.entity_id && !hasSeenTask(myId, a.entity_id)) continue;
      // Echo's own notices (a hand-over climbing) have no one behind them.
      if (!a.actor_id) { toast(`🔔 ${a.summary}`); continue; }
      const summary = a.summary.charAt(0).toLowerCase() + a.summary.slice(1);
      const note = a.verb === "sent_back" && typeof a.meta?.note === "string" ? a.meta.note : undefined;
      toast(`🔔 ${a.actor_name ?? "Someone"} ${summary}`, { description: note });
    }
    if (fresh.some((a) => a.entity_type === "task")) notifyTasksChanged();
    if (fresh.some((a) => a.verb.startsWith("attendance_"))) window.dispatchEvent(new Event("pulse:attendance-changed"));
  }, [items, myId, myEditorId]);
}

function metaFor(pathname: string): [string, string] {
  if (PAGE_META[pathname]) return PAGE_META[pathname];
  const hit = Object.keys(PAGE_META).find((k) => pathname.startsWith(k));
  return hit ? PAGE_META[hit] : ["Echo", ""];
}

// Team chat's live stream and unread counts live for as long as you're signed
// in, so a DM or mention reaches you on any page — see lib/chat.tsx.
export function AppShell() {
  return (
    <ChatProvider>
      <AppShellInner />
    </ChatProvider>
  );
}

// The sidebar's Team Chat count: red for @mentions and unread DMs, a quiet dot
// when only channel messages are waiting.
// The accent colour picker in the top bar: violet, blue or green tints the
// background and every highlight (index.css --acH).
// Appearance: light or dark, and the accent colour — one button in the top bar.
function AccentPicker() {
  const { accent, setAccent, theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const cur = ACCENTS.find((a) => a.key === accent) ?? ACCENTS[0];
  return (
    <div className="accent-pick" ref={ref}>
      <button type="button" className="btn icon" title="Theme and accent colour" aria-label={`Theme: ${theme}, accent colour: ${cur.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="accent-dot" style={{ background: cur.swatch }} />
      </button>
      {open && (
        <div className="accent-pop" role="menu" aria-label="Theme and accent colour">
          <b>Theme</b>
          <div className="theme-seg" role="radiogroup" aria-label="Theme">
            {(["light", "dark"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""}
                onClick={() => { if (theme !== t) toggle(); }}>
                <Icon name={t === "light" ? "light_mode" : "dark_mode"} size={17} />{t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
          <b>Accent colour</b>
          <div className="accent-grid">
            {ACCENTS.map((a) => (
              <button key={a.key} type="button" role="menuitemradio" aria-checked={accent === a.key} aria-label={a.label} title={a.label}
                className={accent === a.key ? "on" : ""} onClick={() => setAccent(a.key)}>
                <span className="accent-tile" style={{ background: a.swatch }}>
                  {accent === a.key && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </span>
                <span className="accent-name">{a.label}</span>
              </button>
            ))}
          </div>
          <span className="accent-note">Only for you, on this browser.</span>
        </div>
      )}
    </div>
  );
}

// Phones: the same choice as three dots in the More menu, so the top bar keeps room for the page name.
function AccentRow() {
  const { accent, setAccent } = useTheme();
  return (
    <div className="sb2-accent" role="radiogroup" aria-label="Accent colour">
      <span>Accent colour</span>
      <div>
        {ACCENTS.map((a) => (
          <button key={a.key} type="button" role="radio" aria-checked={accent === a.key} aria-label={a.label} title={a.label}
            className={accent === a.key ? "on" : ""} onClick={() => setAccent(a.key)}>
            <span className="accent-tile" style={{ background: a.swatch }} />
          </button>
        ))}
      </div>
    </div>
  );
}

// How many requests wait on you (lib/use-inbox.ts; the shell keeps it fresh).
function InboxBadge() {
  const { user } = useAuth();
  const { data } = useInbox(user?.id ?? "");
  const n = data?.count ?? 0;
  return n > 0 ? <span className="badge alert" aria-label={`${n} waiting`}>{n > 99 ? "99+" : n}</span> : null;
}

function ChatBadge() {
  const { totals } = useChat();
  if (totals.alerts > 0) return <span className="badge alert">{totals.alerts > 99 ? "99+" : totals.alerts}</span>;
  if (totals.unread > 0) return <span className="badge dot" aria-label="Unread messages" />;
  return null;
}

function AppShellInner() {
  const { user, logout } = useAuth();
  const { available: chatAvailable } = useChat();
  const { active, workspaces, isAdmin, hasPermission } = useWorkspaces();
  // EOD lockout: an editor with no open session gets the whole shell grayscaled
  // and non-interactive (except a few live controls) until they Start EOD. The
  // grayscale/disable is CSS keyed off this class; see index.css `.eod-lock`.
  const {
    session: eodSession, summary: eodSummary,
    eodOpen, openEod, signOutAfter, clearSignOutAfter, start: startEod, busy: eodBusy,
  } = useEodState();
  // Viewing as someone is look-only, so their Start Work lock doesn't apply.
  // Settings › Attendance › Require Start of day off: nothing waits for it.
  const { org: orgSettings } = useOrg();
  const eodLocked = useDayLocked();
  const [viewAsOpen, setViewAsOpen] = useState(false);
  // New task (sidebar, phone +) opens its sheet over whatever page you're on.
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // A page (href) or an action (then) that waits for Start Work, asked for
  // while the day isn't started.
  const [lockAsk, setLockAsk] = useState<{ title: string; href?: string; state?: unknown; then?: () => void } | null>(null);
  // Any page can ask (lib/eod-context.tsx askStartDay), e.g. the board's New task.
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; then: () => void }>).detail;
      if (d) setLockAsk({ title: d.title, then: d.then });
    };
    window.addEventListener("pulse:ask-start-day", onAsk);
    return () => window.removeEventListener("pulse:ask-start-day", onAsk);
  }, []);
  // New task needs the day started: ask first rather than after the form is filled.
  const openNewTask = () => {
    setMenuOpen(false);
    if (eodLocked) setLockAsk({ title: "New task", then: () => setNewTaskOpen(true) });
    else setNewTaskOpen(true);
  };
  const { editors } = useEditors();
  const location = useLocation();
  const navigate = useNavigate();
  // the sidebar's posts number: just the count (not every post), re-read on moving between pages
  const { data: postCountData, refetch: refetchPostCount } = useResource<{ count: number }>("/posts/count");
  // Scheduling shows for this month's schedulers (a Schedule goal), Managers and Team Leads
  const { data: schedAccess } = useResource<{ allowed: boolean }>("/scheduling/access");
  // Ad uploads shows for the Managers and Team Leads, with how many approved ads wait
  const { data: uploadsAccess, refetch: refetchUploads } = useResource<{ allowed: boolean; waiting: number }>("/ad-uploads/access");
  useEffect(() => { refetchPostCount().catch(() => {}); refetchUploads().catch(() => {}); }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const postCount = postCountData?.count ?? null;
  const { unread, items: activityItems } = useUnreadActivity();
  // the Inbox's count, re-read every minute for the sidebar badge
  useInbox(user?.id ?? "", true);
  // The bell opens a small box of the latest notices (See all opens Activity).
  // What was read before it opened stays marked as read; the rest show as new.
  const [notifyOpen, setNotifyOpen] = useState(false);
  // the top bar's Attendance: the attendance month and leave, in the side panel (pages/leave.tsx)
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [seenAtOpen, setSeenAtOpen] = useState("");
  const bellRef = useRef<HTMLButtonElement>(null);
  const closeNotify = useCallback(() => setNotifyOpen(false), []);
  const toggleNotify = () => {
    if (notifyOpen) return setNotifyOpen(false);
    setSeenAtOpen(getActivitySeen());
    if (activityItems?.length) markActivitySeen(activityItems[0].created_at);
    setNotifyOpen(true);
  };
  useLiveNotices(activityItems, user?.id, user?.editorId);
  // Anyone who reviews hears when work lands in review for them (or reaches
  // them after 24 hours) — each task says can_review.
  const review = useReviewAccess();
  // the alerts' one shared list of open tasks: the team's for admins and
  // reviewers, otherwise just your own (lib/use-task-alerts.ts)
  const alertTasks = useTaskAlertList(isAdmin || review.reviewer ? "team" : user?.editorId ? "mine" : null, user?.id ?? "");
  useTaskAssignNotify(alertTasks);
  useOverdueTaskNotify(alertTasks);
  useDueOverdueNotify(alertTasks);
  useReviewWaitingNotify(review.reviewer, (t) => !!t.can_review, alertTasks);
  // The organisation's name (sidebar) and week start (date ranges).
  const { org } = useOrg();
  useEffect(() => { if (org) setWeekStart(org.weekStart); }, [org?.weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  // App-wide auto-sync: only ADMIN tabs poll (keeps the trigger surface small
  // with many users online); runs on any page while the tab is active, on the
  // org's interval. No-op unless an admin enabled the kill switch.
  useAutoSync(undefined, undefined, { active: isAdmin });
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Sidebar: collapsed to an icon rail (remembered on this device), and the
  // Search or jump to… palette (also Ctrl/⌘ K).
  const [rail, setRail] = useState(() => { try { return window.localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } });
  // Collapsing or expanding glides in one motion — sidebar.css does it all.
  function toggleRail() {
    setRail((r) => {
      try { window.localStorage.setItem(RAIL_KEY, r ? "0" : "1"); } catch { /* fine, just not remembered */ }
      return !r;
    });
  }
  const [jumpOpen, setJumpOpen] = useState(false);
  // The top bar's height as --topbar-h, so what sticks while the page scrolls
  // (the Leaderboard's column titles, its Top Performer card) stops below it.
  const topbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--topbar-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const canWrite = active?.role !== "viewer";
  // My Team: admins, plus team leads and managers (Attendance only).
  const myEd = (editors ?? []).find((e) => e.id === user?.editorId) ?? null;
  const leadsPeople = !isAdmin && homeRoleOf(myEd?.designation, false) !== "editor"
    && seesTeamAttendance(myEd?.designation, false, orgSettings?.attendance?.teamView);
  const canSee = (i: NavItem) => (!i.adminOnly || isAdmin || (!!i.permission && hasPermission(i.permission)) || (i.href === "/my-team" && leadsPeople))
    && (!i.chatBadge || chatAvailable)
    && (!i.schedulerOnly || !!schedAccess?.allowed)
    && (!i.uploadsOnly || !!uploadsAccess?.allowed);
  const placed = new Set(SIDEBAR_GROUPS.flatMap((g) => g.hrefs));
  const sideGroups = SIDEBAR_GROUPS.map((g, gi) => ({
    label: g.label,
    items: [
      ...g.hrefs.map((h) => NAV_ITEMS.find((i) => i.href === h)),
      ...(gi === SIDEBAR_GROUPS.length - 1 ? NAV_ITEMS.filter((i) => !placed.has(i.href) && !OFF_SIDEBAR.has(i.href)) : []),
    ].filter((i): i is NavItem => !!i && canSee(i)),
  }));
  // The phone tab bar: the Workspace places you can see; More lights up anywhere else.
  const tabItems = (sideGroups[0]?.items ?? []).slice(0, 4);
  const onTab = tabItems.some((i) => location.pathname === i.href || location.pathname.startsWith(i.href + "/"));
  // The phone menu doesn't repeat the places the tab bar already has.
  const tabHrefs = new Set(tabItems.map((i) => i.href));
  // Phones: the menu is a sheet; drag its handle down to close it.
  const sheetRef = useRef<HTMLElement>(null);
  const dragFrom = useRef<number | null>(null);
  const sheetDrag = {
    onTouchStart: (e: React.TouchEvent) => { dragFrom.current = e.touches[0].clientY; },
    onTouchMove: (e: React.TouchEvent) => {
      const el = sheetRef.current;
      if (dragFrom.current == null || !el) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - dragFrom.current)}px)`;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const el = sheetRef.current;
      if (dragFrom.current == null || !el) return;
      const moved = e.changedTouches[0].clientY - dragFrom.current;
      dragFrom.current = null;
      el.style.transition = "";
      el.style.transform = "";
      if (moved > 70) setMenuOpen(false);
    },
  };
  const addPostItem = NAV_ITEMS.find((i) => i.href === "/posts/new");
  const settingsItem = NAV_ITEMS.find((i) => i.href === "/settings");
  const jumpItems: JumpItem[] = [
    ...sideGroups.flatMap((g) => g.items.map((i) => ({ title: i.title, href: i.href, icon: navIcon(i.href) ?? i.icon, group: g.label }))),
    ...(addPostItem && canSee(addPostItem) ? [{ title: addPostItem.title, href: addPostItem.href, icon: navIcon(addPostItem.href) ?? addPostItem.icon, group: "Create", state: { backgroundLocation: location } }] : []),
    ...(settingsItem ? [{ title: settingsItem.title, href: settingsItem.href, icon: GEAR_ICON, group: "Account" }] : []),
  ];

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Ctrl/⌘ K opens Search or jump to… (not while the day is locked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!eodLocked) setJumpOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [eodLocked]);

  // A locked editor can only act on My Day (it holds the live Start EOD button)
  // and the lock disables the nav, so landing anywhere else — sign-in, refresh,
  // an old link — would strand them on a dead page. Send them to My Day. The
  // exceptions (OPEN_WHEN_LOCKED): Activity, Team Chat, the Task Board,
  // Analytics and Settings. Each gets a way back in the top bar, see below.
  const lockedOnOpenPage = eodLocked && openWhenLocked(location.pathname) && location.pathname !== "/home";
  useEffect(() => {
    if (eodLocked && !openWhenLocked(location.pathname)) {
      navigate("/home", { replace: true });
    }
  }, [eodLocked, location.pathname, navigate]);

  const [title, sub] = metaFor(location.pathname);
  const initial = (user?.name || user?.email || "?").charAt(0).toUpperCase();
  // Prefer the person's actual designation (Team Lead, Manager, Video
  // Editor…) from their linked roster record over the generic account role —
  // "Admin" under your name reads like a job title, which it isn't. Falls
  // back to the role for anyone not on the roster (viewers/editors only —
  // an admin with no designation gets the glow ring below instead of text).
  const myDesignation = editors?.find((e) => e.id === user?.editorId)?.designation || null;
  const roleLabel = active?.role ? active.role.charAt(0).toUpperCase() + active.role.slice(1) : "Member";
  const subtitle = myDesignation || (isAdmin ? null : roleLabel);

  // Signing out doesn't end the work day (someone may just be switching
  // devices), so a clocked-in employee is asked which they mean.
  const [signOutAsk, setSignOutAsk] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  async function handleSignOut() {
    if (active?.role === "editor" && eodSession) { setSignOutAsk(true); return; }
    await signOut(false);
  }
  // "End Work and sign out" goes through the End of Day window (notes, then
  // End Work) and the day's summary; closing the summary finishes the sign-out.
  // Closing the window without ending cancels it.
  async function signOut(endWorkFirst: boolean) {
    setSignOutAsk(false);
    if (endWorkFirst) {
      openEod(true);
      return;
    }
    setSigningOut(true);
    await logout();
    navigate("/login", { replace: true });
  }
  useEffect(() => {
    if (!signOutAfter || eodOpen || eodSession || eodSummary) return;
    clearSignOutAfter();
    logout().then(() => navigate("/login", { replace: true }));
  }, [signOutAfter, eodOpen, eodSession, eodSummary, clearSignOutAfter, logout, navigate]);

  return (
    <BreakProvider>
    <div className={"app" + (menuOpen ? " menu-open" : "") + (eodLocked ? " eod-lock" : "") + (lockedOnOpenPage ? " lock-page-open" : "") + (rail ? " sb-rail" : "")}>
      <div className="app-backdrop" onClick={() => setMenuOpen(false)} />
      {/* sb2: the redesign's sidebar (components/sidebar.css) — brand and
          collapse, search and new task, the Workspace / Operations groups,
          your channels, then break time and you. */}
      <aside className="sb2" ref={sheetRef}>
        {/* phones only: the sheet's handle, title and Close (components/mobile.css) */}
        <div className="sb2-sheethead" {...sheetDrag}>
          <span className="sb2-grab" aria-hidden="true" />
          <b>Menu</b>
          <button type="button" className="sb2-sheetx" aria-label="Close menu" onClick={() => setMenuOpen(false)}>{CLOSE_ICON}</button>
        </div>
        <div className="brand">
          {/* the logo goes Home, for everyone (a Super Admin's View as is in My Profile) */}
          <Link to="/home" className="logo echo-logo em-hover" title="Home" aria-label="Echo, go to Home" onClick={() => setMenuOpen(false)}><EchoMark /></Link>
          <div className="sb2-label sb2-brandtx">
            <b>Echo</b>
            <small>{org?.name || "Content Analytics"}</small>
          </div>
          <button type="button" className="sb2-iconbtn sb2-railbtn" onClick={toggleRail} aria-pressed={rail}
            title={rail ? "Expand the sidebar" : "Collapse the sidebar"} aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"}>
            {RAIL_ICON}
          </button>
        </div>
        <div className="sb2-tools">
          {/* folded rail only: the search box becomes a tile above New task */}
          <button type="button" className="sb2-railsearch" onClick={() => setJumpOpen(true)} title="Search or jump to… (Ctrl K)" aria-label="Search or jump to">
            {SEARCH_ICON}
          </button>
          <button type="button" className="sb2-search" onClick={() => setJumpOpen(true)} title="Search or jump to… (Ctrl K)" aria-label="Search or jump to">
            {SEARCH_ICON}<span className="sb2-label">Search</span><kbd className="sb2-label">Ctrl K</kbd>
          </button>
          {canWrite && (
            <button type="button" className="sb2-compose" title="New task" aria-label="New task"
              onClick={openNewTask}>
              {COMPOSE_ICON}
            </button>
          )}
        </div>
        <nav className="side">
          {sideGroups.filter((g) => g.items.length > 0).map((g) => (
            <div key={g.label} className={"sb2-group" + (g.items.every((i) => tabHrefs.has(i.href)) ? " in-tabbar" : "")}>
              <div className="navsec"><span className="sb2-label">{g.label}</span></div>
              <div className="sb2-items">
              {g.items.map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  end={item.href === "/posts"}
                  title={rail ? item.title : undefined}
                  onClick={(e) => {
                    if (eodLocked && !LIVE_WHEN_LOCKED.has(item.href)) { e.preventDefault(); setLockAsk({ title: item.title, href: item.href }); return; }
                    setMenuOpen(false);
                  }}
                  aria-disabled={eodLocked && !LIVE_WHEN_LOCKED.has(item.href) ? true : undefined}
                  className={({ isActive }) =>
                    "navitem" + (isActive ? " active" : "") + (eodLocked && LIVE_WHEN_LOCKED.has(item.href) ? " eod-live" : "") + (tabHrefs.has(item.href) ? " in-tabbar" : "")
                  }
                >
                  <span className="ic">{navIcon(item.href) ?? item.icon}</span> <span className="sb2-label">{item.title}</span>
                  {item.showBadge && postCount !== null && (
                    <span className="badge">{postCount}</span>
                  )}
                  {item.uploadsOnly && !!uploadsAccess?.waiting && <span className="badge">{uploadsAccess.waiting}</span>}
                  {item.chatBadge && <ChatBadge />}
                  {item.inboxBadge && <InboxBadge />}
                </NavLink>
              ))}
              </div>
            </div>
          ))}
        </nav>
        <SidebarBreak />
        <AccentRow />
        <div className="userchip">
          <button
            type="button"
            className="userchip-open"
            title="My Profile"
            onClick={() => setProfileOpen(true)}
            style={{ all: "unset", display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, cursor: "pointer" }}
          >
            {/* Admin gets a glow ring instead of an "Admin" text label — same
                idea as a verified/paid-tier ring elsewhere (Gmail, etc.). */}
            <div className={"avatar-ring" + (isAdmin ? " admin" : "")}>
              <div className="avatar" style={{ background: user?.imageUrl ? undefined : (user?.color ?? undefined), overflow: "hidden" }}>
                {user?.imageUrl ? <img src={user.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initial}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <div className="nm">{user?.name || user?.email || "Account"}</div>
              {subtitle && <div className="rl">{subtitle}</div>}
            </div>
          </button>
          {settingsItem && (
            <NavLink to={settingsItem.href} className={({ isActive }) => "sb2-iconbtn sb2-gear" + (isActive ? " active" : "")}
              title="Settings" aria-label="Settings" onClick={() => setMenuOpen(false)}>
              {GEAR_ICON}
            </NavLink>
          )}
          <button className="logout" title="Sign out" aria-label="Sign out" onClick={handleSignOut}>
            {SIGN_OUT_ICON}
          </button>
        </div>
        {jumpOpen && <JumpPalette items={jumpItems} onClose={() => setJumpOpen(false)} />}
        {profileOpen && (
          <MyProfileModal onClose={() => setProfileOpen(false)}
            onViewAs={user?.isSuperAdmin && !user.viewingAs ? () => { setProfileOpen(false); setViewAsOpen(true); } : undefined} />
        )}
        {signOutAsk && (
          <Modal title="You're still clocked in" onClose={() => setSignOutAsk(false)}>
            <p style={{ margin: "0 0 14px", lineHeight: 1.5 }}>
              Signing out doesn't end your work day. End Work now, or stay clocked in if you're just switching to
              another device.
            </p>
            <div className="formfoot">
              <button className="btn" disabled={signingOut} onClick={() => setSignOutAsk(false)}>Cancel</button>
              <button className="btn" disabled={signingOut} onClick={() => signOut(false)}>Sign out, stay clocked in</button>
              <button className="btn btn-primary" disabled={signingOut} onClick={() => signOut(true)}>
                {signingOut ? "Signing out…" : "End Work and sign out"}
              </button>
            </div>
          </Modal>
        )}
      </aside>

      <main>
        <div className="topbar" ref={topbarRef}>
          <button
            className="btn icon menu-btn"
            title="Menu"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </button>
          <div className="topbar-title">
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
          <div className="spacer" />
          {lockedOnOpenPage && (
            <>
              <button className="btn btn-primary topbar-startday" disabled={eodBusy}
                title="Your tasks, timers and new tasks wait for Start day"
                onClick={() => { startEod().catch(() => {}); }}>
                {eodBusy ? "Starting…" : "▶ Start day"}
              </button>
              <button className="btn" onClick={() => navigate("/home")}>← My Day</button>
            </>
          )}
          {/* who else has Echo open: hover for names, click one to chat */}
          <OnlineNow />
          {(user?.editorId || isAdmin) && (
            <button type="button" className="btn top-leave" onClick={() => setLeaveOpen(true)} title="Attendance and leave" aria-label="Attendance">
              <Icon name="event_available" size={18} /><span className="top-leave-l">Attendance</span>
            </button>
          )}
          <div className="nt-wrap">
            <button
              ref={bellRef}
              className={"btn icon bell-btn" + (notifyOpen || location.pathname === "/activity" ? " on" : "")}
              title="Notifications"
              aria-label={unread > 0 ? `Notifications, ${unread} new` : "Notifications"}
              aria-expanded={notifyOpen}
              onClick={toggleNotify}
            >
              🔔
              {unread > 0 && <span className="bell-dot">{unread > 9 ? "9+" : unread}</span>}
            </button>
            {notifyOpen && (
              <NotifyPanel
                items={activityItems}
                seenBefore={seenAtOpen}
                anchor={bellRef}
                onClose={closeNotify}
                onSeeAll={() => { setNotifyOpen(false); navigate("/activity"); }}
                onOpenTask={(id) => { setNotifyOpen(false); navigate("/tasks", { state: { openTask: id } }); }}
              />
            )}
          </div>
          <AccentPicker />
          {(isAdmin || hasPermission("create_post")) && (
            <button
              className="btn btn-primary add-post-btn"
              onClick={() => navigate("/posts/new", { state: { backgroundLocation: location } })}
            >
              <span className="ap-plus">＋</span>
              <span className="ap-text"> Add Post</span>
            </button>
          )}
        </div>
        <div className="content">
          {/* a page that breaks says so (the sidebar stays); another page starts afresh */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      {/* Phones: an app-style tab bar (components/mobile.css) — the four
          Workspace places and More for the full menu, in a floating pill, with
          New task as a round button beside it. */}
      <nav className={"tabbar" + (canWrite ? " has-fab" : "")} aria-label="Main">
        {tabItems.map((item) => (
          <NavLink key={item.href} to={item.href} aria-label={item.title} className={({ isActive }) => "tab" + (isActive && !menuOpen ? " on" : "") + (eodLocked && LIVE_WHEN_LOCKED.has(item.href) ? " eod-live" : "")} onClick={() => setMenuOpen(false)}>
            <span className="tab-ic">{navIcon(item.href) ?? item.icon}{item.chatBadge && <ChatBadge />}{item.inboxBadge && <InboxBadge />}</span>
            <span className="tab-l" aria-hidden="true">{TAB_SHORT[item.href] ?? item.title}</span>
          </NavLink>
        ))}
        <button type="button" className={"tab" + (menuOpen || !onTab ? " on" : "")} onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-label="More: the full menu">
          <span className="tab-ic">{MORE_ICON}</span>
          <span className="tab-l">More</span>
        </button>
      </nav>
      {canWrite && (
        <button type="button" className="tab-fab" title="New task" aria-label="New task"
          onClick={openNewTask}>
          {PLUS_ICON}
        </button>
      )}
      <BreakWidget />
      <BreakOverlay />
      <SodModal />
      {viewAsOpen && <ViewAsModal onClose={() => setViewAsOpen(false)} />}
      {leaveOpen && <LeavePanel onClose={() => setLeaveOpen(false)} />}
      {newTaskOpen && (
        <TaskPanel
          mode="create" task={null} canWrite={canWrite} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => setNewTaskOpen(false)}
          onChanged={notifyTasksChanged}
          onCreated={(id) => {
            setNewTaskOpen(false);
            // Every task list reloads; on the Task Board the new task opens.
            notifyTasksChanged();
            if (location.pathname === "/tasks") navigate("/tasks", { replace: true, state: { openTask: id } });
          }}
        />
      )}
      {lockAsk && (
        <Modal title="Start your day first" onClose={() => setLockAsk(null)}>
          <div className="lock-ask">
            {lockAsk.then
              ? <p><b>{lockAsk.title}</b> needs your day started. Tasks are made and worked on once you tap Start day.</p>
              : <p><b>{lockAsk.title}</b> opens once you start your day. Social & Ads Pipeline, Posts, Leaderboard and Goals all wait for Start day.</p>}
            <div className="lock-ask-acts">
              <button type="button" className="btn" onClick={() => setLockAsk(null)}>Not now</button>
              <button type="button" className="btn btn-primary" disabled={eodBusy}
                onClick={async () => {
                  const to = lockAsk;
                  try { await startEod(); } catch { return; }
                  setLockAsk(null); setMenuOpen(false);
                  if (to.then) to.then();
                  else if (to.href) navigate(to.href, to.state ? { state: to.state } : undefined);
                }}>
                {eodBusy ? "Starting…" : "▶ Start day"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {user?.viewingAs && <ViewAsBar name={user.name || user.email} realName={user.viewingAs.name} />}
    </div>
    </BreakProvider>
  );
}
