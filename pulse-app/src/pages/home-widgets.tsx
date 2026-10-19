import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Icon } from "@/components/icon";
import { Avatar } from "@/lib/editor-visuals";
import { clockTime } from "@/lib/time-format";
import { compactNum } from "@/lib/date-range";
import { performanceScore } from "@/lib/score";
import { capacityFor, type WorkCalendar } from "@/lib/work-calendar";
import { ymd, taskPoints, isScorableTask, topEditorsInRange } from "@/lib/task-points";
import { breakOffsetMs, DAILY_BREAK_CAP_SEC } from "@/lib/task-timing";
import { HOME_ROLE_LABEL, type HomeRole } from "@/lib/home-role";
import { DEFAULT_LAYOUT, WIDGETS, WIDGET_ORDER, allowed, cleanLayout, type LayoutItem, type Size, type WidgetKey } from "@/lib/home-widgets";
import { attendanceAction, type AttToday, type TeamPerson } from "@/lib/use-attendance";
import { Bar, ReviewList, UpNext, monthName, taskRef, type MyDayData, type useMyGoal, type useStartFlow } from "@/pages/my-day-layouts";
import type { Editor, Post, Task } from "@/lib/types";
import "./home-widgets.css";

// Home by role (Pulse Redesign v7): the greeting row (with "Preview as" for
// admins and Customize), then — passed in — the Start of day section, then the
// widget grid. Each person's layout is saved per Home role on the server;
// admins can publish a layout as a role's default.

export type HomeCtx = {
  role: HomeRole;
  d: MyDayData;
  tasks: Task[];
  editors: Editor[];
  posts: Post[];
  goalTotals: { editorId: string; goalPoints: number }[];
  att: AttToday | null;
  cal: WorkCalendar | null;
  myEditorId: string | null;
  firstName: string;
  nowMs: number;
  today: string;
  // The people a lead or manager looks after; null = the whole workspace.
  teamIds: Set<string> | null;
  checkedIn: boolean;
  goal: ReturnType<typeof useMyGoal>;
  flow: ReturnType<typeof useStartFlow>;
  onOpenTask: (id: string) => void;
  onChanged: () => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Saved layouts
// ---------------------------------------------------------------------------

type Saved = { layout: LayoutItem[]; banner: boolean };
export function useHomeLayout(role: HomeRole) {
  const [mine, setMine] = useState<Partial<Record<HomeRole, Saved>>>({});
  const [defaults, setDefaults] = useState<Partial<Record<HomeRole, LayoutItem[]>>>({});
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Saved | null>(null);
  useEffect(() => {
    api<{ mine: Record<string, { layout: unknown; banner: boolean }>; defaults: Record<string, unknown> }>("/home/layout")
      .then((d) => {
        const m: Partial<Record<HomeRole, Saved>> = {};
        const df: Partial<Record<HomeRole, LayoutItem[]>> = {};
        for (const r of ["manager", "lead", "editor"] as HomeRole[]) {
          if (d.mine?.[r]) m[r] = { layout: cleanLayout(d.mine[r].layout, r), banner: d.mine[r].banner !== false };
          if (d.defaults?.[r]) df[r] = cleanLayout(d.defaults[r], r);
        }
        setMine(m); setDefaults(df);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const base = useCallback((r: HomeRole): Saved => ({ layout: defaults[r] ?? DEFAULT_LAYOUT[r], banner: true }), [defaults]);
  const current: Saved = draft ?? mine[role] ?? base(role);
  // Leaving Customize when the role being previewed changes.
  useEffect(() => { setDraft(null); }, [role]);
  const editing = draft !== null;
  return {
    loaded, editing,
    items: current.layout,
    banner: current.banner,
    begin: () => setDraft({ ...current, layout: [...current.layout] }),
    setItems: (layout: LayoutItem[]) => setDraft((d) => ({ ...(d ?? current), layout })),
    setBanner: (banner: boolean) => {
      if (draft) setDraft({ ...draft, banner });
      else {
        const next = { ...current, banner };
        setMine((m) => ({ ...m, [role]: next }));
        api("/home/layout", { method: "PUT", body: JSON.stringify({ role, ...next }) }).catch(() => {});
      }
    },
    async done() {
      if (!draft) return;
      try {
        await api("/home/layout", { method: "PUT", body: JSON.stringify({ role, layout: draft.layout, banner: draft.banner }) });
        setMine((m) => ({ ...m, [role]: draft }));
        setDraft(null);
        toast.success("Home layout saved");
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Couldn't save your Home.");
      }
    },
    async reset() {
      try {
        await api(`/home/layout?role=${role}`, { method: "DELETE" });
        setMine((m) => { const n = { ...m }; delete n[role]; return n; });
        // Back on the role's default (and following it from now on).
        setDraft(null);
        toast.success(`Reset to the ${HOME_ROLE_LABEL[role]} default`);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Couldn't reset your Home.");
      }
    },
    async publish() {
      try {
        const layout = current.layout;
        await api("/home/default", { method: "PUT", body: JSON.stringify({ role, layout }) });
        setDefaults((d) => ({ ...d, [role]: layout }));
        toast.success(`Every ${HOME_ROLE_LABEL[role]} now starts with this Home — they can still customise theirs`);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Couldn't set the default.");
      }
    },
  };
}
export type HomeLayout = ReturnType<typeof useHomeLayout>;

// ---------------------------------------------------------------------------
// Greeting row, Customize panel, grid
// ---------------------------------------------------------------------------

export function HomeWidgets({ c, layout, showHello, hello, canPreview, previewRole, onPreview, sod, blocked = [] }: {
  c: HomeCtx;
  layout: HomeLayout;
  showHello: boolean;
  hello: string;
  canPreview: boolean;
  previewRole: HomeRole | null;
  onPreview: (r: HomeRole | null) => void;
  sod: ReactNode;
  // Widgets this person can't have though their role could (e.g. Team today
  // when their position may not see the team's attendance).
  blocked?: WidgetKey[];
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      setCols(w >= 980 ? 3 : w >= 620 ? 2 : 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const role = c.role;
  const ok = (k: WidgetKey) => allowed(k, role) && !blocked.includes(k);
  const items = layout.items.filter(([k]) => ok(k));
  const notAllowed = WIDGET_ORDER.filter((k) => !ok(k));
  const addable = WIDGET_ORDER.filter((k) => ok(k) && !items.some(([x]) => x === k));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    layout.setItems(next);
  };
  const resize = (i: number, s: Size) => layout.setItems(items.map((it, k) => (k === i ? [it[0], s] : it)));
  const remove = (i: number) => layout.setItems(items.filter((_, k) => k !== i));

  return (
    <div className="hw">
      <div className="hw-greet">
        <div className="hw-greet-txt">
          {showHello && <h1>{hello}</h1>}
          <span>{greetingSub(c)}</span>
        </div>
        <span className="hw-grow" />
        {canPreview && (
          <span className="hw-preview">
            <span className="hw-faint">Preview as</span>
            <span className="hw-seg" role="group" aria-label="Preview Home as">
              {(["manager", "lead", "editor"] as HomeRole[]).map((r) => (
                <button key={r} type="button" aria-pressed={role === r} className={role === r ? "on" : undefined}
                  onClick={() => onPreview(previewRole === r ? null : r)}>
                  {HOME_ROLE_LABEL[r]}
                </button>
              ))}
            </span>
          </span>
        )}
        {!layout.editing && (
          <button type="button" className="hw-btn" onClick={layout.begin}><Icon name="dashboard_customize" size={17} />Customize</button>
        )}
      </div>

      {sod}

      {layout.editing && (
        <section className="hw-edit" aria-label="Customize Home">
          <div className="hw-edit-top">
            <div>
              <b>Customizing the {HOME_ROLE_LABEL[role]} home</b>
              <span>Move, resize or remove widgets. Add more from below.</span>
            </div>
            <span className="hw-grow" />
            <button type="button" className="hw-btn" onClick={() => layout.setBanner(!layout.banner)}>
              <Icon name={layout.banner ? "visibility_off" : "visibility"} size={17} />{layout.banner ? "Hide banner" : "Show banner"}
            </button>
            <button type="button" className="hw-btn" onClick={layout.reset}><Icon name="restart_alt" size={17} />Reset</button>
            {canPreview && (
              <button type="button" className="hw-btn" onClick={layout.publish}><Icon name="groups" size={17} />Set as default for {HOME_ROLE_LABEL[role]}s</button>
            )}
            <button type="button" className="hw-btn primary" onClick={layout.done}><Icon name="check" size={17} />Done</button>
          </div>
          {addable.length > 0 && (
            <div className="hw-add">
              <span className="hw-add-l">Add</span>
              {addable.map((k) => (
                <button key={k} type="button" className="hw-chip" onClick={() => layout.setItems([...items, [k, 1]])}>
                  <Icon name="add" size={16} className="hw-ac" /><Icon name={WIDGETS[k].icon} size={16} className="hw-faint" />{WIDGETS[k].title}
                </button>
              ))}
            </div>
          )}
          {notAllowed.length > 0 && (
            <div className="hw-locked"><Icon name="lock" size={15} />Not available to {HOME_ROLE_LABEL[role]}s: {notAllowed.map((k) => WIDGETS[k].title).join(", ")}</div>
          )}
        </section>
      )}

      <div ref={gridRef} className="hw-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {items.length === 0 && <div className="hw-none" style={{ gridColumn: "1 / -1" }}>No widgets yet — add some from Customize.</div>}
        {items.map(([k, size], i) => {
          const w = WIDGETS[k];
          const span = Math.min(size, cols);
          const head = headSub(k, c);
          return (
            <section key={k} className={"hw-card" + (layout.editing ? " editing" : "")} style={{ gridColumn: `span ${span}` }} aria-label={w.title}>
              <header className="hw-head">
                <Icon name={w.icon} size={17} className="hw-faint" />
                <h2>{w.title}</h2>
                {head && <span className="hw-sub">{head}</span>}
                <span className="hw-grow" />
                {layout.editing ? (
                  <span className="hw-tools">
                    <span className="hw-seg sm" role="group" aria-label="Size">
                      {([1, 2, 3] as Size[]).map((s) => (
                        <button key={s} type="button" aria-pressed={size === s} className={size === s ? "on" : undefined} onClick={() => resize(i, s)}>{"SML"[s - 1]}</button>
                      ))}
                    </span>
                    <button type="button" className="hw-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move earlier" title="Move earlier"><Icon name="arrow_upward" size={16} /></button>
                    <button type="button" className="hw-icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move later" title="Move later"><Icon name="arrow_downward" size={16} /></button>
                    <button type="button" className="hw-icon bad" onClick={() => remove(i)} aria-label={`Remove ${w.title}`} title="Remove"><Icon name="close" size={16} /></button>
                  </span>
                ) : w.link ? <Link to={w.link.to} className="hw-link">{w.link.label}</Link> : null}
              </header>
              <WidgetBody k={k} c={c} cols={cols} span={span} />
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared figures
// ---------------------------------------------------------------------------

const inTeam = (c: HomeCtx, editorId: string | null) => !!editorId && (c.teamIds ? c.teamIds.has(editorId) : true);
const teamEditors = (c: HomeCtx) => c.editors.filter((e) => e.active && (c.teamIds ? c.teamIds.has(e.id) : true) && !e.is_admin);
const monthStart = (today: string) => today.slice(0, 7) + "-01";
const pctTone = (p: number) => (p >= 80 ? "good" : p >= 50 ? "warn" : "bad");

function monthPointsBy(c: HomeCtx) {
  const from = monthStart(c.today);
  const m = new Map<string, number>();
  for (const t of c.tasks) {
    if (!t.editor_id || !t.completed_at || !isScorableTask(t)) continue;
    const day = ymd(new Date(t.completed_at));
    if (day < from || day > c.today) continue;
    m.set(t.editor_id, (m.get(t.editor_id) ?? 0) + taskPoints(t));
  }
  return m;
}
function goalPace(c: HomeCtx) {
  const pts = monthPointsBy(c);
  const rows = teamEditors(c)
    .map((e) => {
      const goal = c.goalTotals.find((g) => g.editorId === e.id)?.goalPoints ?? 0;
      return { e, goal, pct: goal > 0 ? Math.round(((pts.get(e.id) ?? 0) / goal) * 100) : null };
    })
    .filter((r): r is { e: Editor; goal: number; pct: number } => r.pct != null)
    .sort((a, b) => a.pct - b.pct);
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length) : null;
  return { rows, avg };
}
function deadlinesOf(c: HomeCtx) {
  return c.tasks
    .filter((t) => t.status !== "done" && t.due_date != null && t.due_date <= c.today && inTeam(c, t.editor_id))
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
}

function greetingSub(c: HomeCtx) {
  const date = new Date(c.nowMs).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  if (c.role === "manager") {
    const { avg } = goalPace(c);
    return `${c.d.waitingOnYou} waiting on you · team at ${avg ?? 0}% of ${monthName()} goals · ${date}`;
  }
  if (c.role === "lead") return `${c.d.reviewQueue.length} to review · ${deadlinesOf(c).length} due today or overdue · ${date}`;
  return `${c.goal?.pct ?? 0}% of your ${monthName()} goals · keep the streak going · ${date}`;
}

function headSub(k: WidgetKey, c: HomeCtx): string {
  switch (k) {
    case "upnext": return "Open tasks assigned to you";
    case "mygoals": return "This month";
    case "reviews": return `${c.d.reviewQueue.length} waiting`;
    case "team": return "Live";
    case "capacity": return "Planned vs capacity";
    case "deadlines": return `${deadlinesOf(c).length} tasks`;
    case "leader": return `${monthName()} points`;
    case "perf": return "Last 7 days";
    case "pipeline": return `${Object.values(c.d.pipeline).reduce((s, n) => s + n, 0)} pieces`;
    case "attend": return c.att ? `As of ${clockTime(new Date(c.att.now))}` : "";
    default: return "";
  }
}

function Face({ editor, name, size = 28 }: { editor?: Editor | null; name: string; size?: number }) {
  return (
    <span className="hw-face" style={{ width: size, height: size }}>
      <Avatar editor={editor ?? ({ id: name, name, designation: "", image_url: null, active: true } as Editor)} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function WidgetBody({ k, c, cols, span }: { k: WidgetKey; c: HomeCtx; cols: number; span: number }) {
  switch (k) {
    case "timer": return <TimerW c={c} />;
    case "upnext": return <div className="hw-flush"><UpNext d={c.d} onOpen={c.onOpenTask} flow={c.flow} /></div>;
    case "mygoals": return <GoalsW c={c} />;
    case "reviews": return <div className="hw-flush">{c.d.canReview ? <ReviewList d={c.d} onOpen={c.onOpenTask} onChanged={c.onChanged} /> : <div className="hw-empty">Reviews come to you when you're a reviewer.</div>}</div>;
    case "team": return <TeamNowW c={c} />;
    case "goalpace": return <GoalPaceW c={c} many={cols > 1} />;
    case "capacity": return <CapacityW c={c} />;
    case "deadlines": return <DeadlinesW c={c} />;
    case "leader": return <LeaderW c={c} />;
    case "perf": return <PerfW c={c} wide={span > 1} />;
    case "pipeline": return <PipelineW c={c} />;
    case "attend": return <AttendW c={c} />;
  }
}

function TimerW({ c }: { c: HomeCtx }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const [busy, setBusy] = useState(false);
  const mine = c.tasks.filter((t) => t.editor_id === c.myEditorId && t.status === "in_progress" && t.budget_started_at && new Date(t.budget_started_at).getTime() <= now);
  const task = mine.find((t) => !t.on_hold) ?? mine[0] ?? null;
  const locked = !!c.att?.settings.requireSod && !!c.att?.checksIn && !c.checkedIn;
  const usedMs = task ? Math.max(0, now - new Date(task.budget_started_at!).getTime() - breakOffsetMs(task, now)) : 0;
  const budgetMs = task?.budget_hours != null ? Number(task.budget_hours) * 3_600_000 : null;
  const hms = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const myTasks = c.tasks.filter((t) => t.editor_id === c.myEditorId);
  const doneToday = myTasks.filter((t) => t.completed_at && ymd(new Date(t.completed_at)) === c.today).length;
  const plate = doneToday + c.d.myTasks.filter((t) => t.due_date != null && t.due_date <= c.today).length;
  const onBreak = myTasks.find((t) => t.editor_break_started_at);
  const breakSec = onBreak ? Math.min(DAILY_BREAK_CAP_SEC, breakOffsetMs(onBreak, now) / 1000) : Math.max(0, ...myTasks.map((t) => t.editor_break_used_seconds ?? 0));
  async function act(body: object, ok: string) {
    if (!task) return;
    if (locked) { toast.error("Start your day first — timers unlock after Start day"); return; }
    setBusy(true);
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await c.onChanged();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update that task.");
      if (e instanceof ApiError && /link|attach/i.test(e.message)) c.onOpenTask(task.id);
    } finally {
      setBusy(false);
    }
  }
  const state = !task ? { l: "Idle", t: "" } : task.on_hold ? { l: "On hold", t: "warn" } : { l: "Running", t: "good" };
  return (
    <div className="hw-pad hw-timer">
      <span className={"hw-state " + state.t}><i />{state.l}</span>
      {task ? (
        <button type="button" className="hw-timer-title" onClick={() => c.onOpenTask(task.id)}>
          <b>{task.title}</b>
          <span>{[taskRef(task), task.content_format_name, task.channel_name].filter(Boolean).join(" · ")}</span>
        </button>
      ) : (
        <div className="hw-timer-title"><b>No task running</b><span>Start one from My tasks</span></div>
      )}
      <div className="hw-clock"><b className="mono">{hms(usedMs)}</b><span>of {budgetMs ? hms(budgetMs).replace(/:00$/, "") : "—"}</span></div>
      <Bar pct={budgetMs ? Math.min(100, (usedMs / budgetMs) * 100) : 0} />
      {task && (
        <div className="hw-row-btns">
          <button type="button" className="hw-btn" disabled={busy} onClick={() => act({ onHold: !task.on_hold }, task.on_hold ? `Resumed “${task.title}”.` : `Put “${task.title}” on hold.`)}>
            <Icon name={task.on_hold ? "play_arrow" : "pause"} size={17} />{task.on_hold ? "Resume" : "Hold"}
          </button>
          <button type="button" className="hw-btn primary" disabled={busy} onClick={() => act({ status: "review" }, `Submitted “${task.title}” for review.`)}>
            <Icon name="send" size={16} />Send for review
          </button>
        </div>
      )}
      {c.myEditorId && (
        <div className="hw-stats">
          <span><b>{doneToday} / {plate}</b><em>tasks today</em></span>
          <span><b>{Math.round(c.d.pointsToday)}</b><em>points today</em></span>
          <span><b>{Math.round(breakSec / 60)} / {DAILY_BREAK_CAP_SEC / 60}m</b><em>break used</em></span>
        </div>
      )}
    </div>
  );
}

function GoalsW({ c }: { c: HomeCtx }) {
  const g = c.goal;
  if (!c.myEditorId) return <div className="hw-empty">Goals show once you're on the team roster.</div>;
  if (!g) return <div className="hw-pad"><b className="hw-big">–</b><p className="hw-note">No goals set for {monthName()} yet.</p></div>;
  return (
    <div className="hw-pad">
      <b className={"hw-big " + pctTone(g.pct)}>{g.pct}%</b>
      <p className="hw-note">{c.firstName}'s {monthName()} targets · {g.done} of {g.target} jobs</p>
      <Bar pct={g.pct} />
    </div>
  );
}

function TeamNowW({ c }: { c: HomeCtx }) {
  const people = (c.att?.team ?? teamEditors(c).map((e) => ({ editorId: e.id, name: e.name, imageUrl: e.image_url, designation: e.designation, status: "waiting" as const, row: null, penalty: 0 })));
  const rows = people.map((p) => {
    const ed = c.editors.find((e) => e.id === p.editorId) ?? null;
    const theirs = c.tasks.filter((t) => t.editor_id === p.editorId);
    const brk = theirs.find((t) => t.editor_break_started_at);
    const working = theirs.find((t) => t.status === "in_progress" && !t.on_hold && t.budget_started_at);
    const r = p.row;
    const kind = r?.checkOutAt ? "wrapped" : brk ? "break" : r?.checkInAt ? "working" : "not";
    const line = kind === "wrapped" ? `Wrapped up ${clockTime(r!.checkOutAt!)}`
      : kind === "break" ? "On a break"
      : kind === "working" ? (working ? working.title : `In since ${clockTime(r!.checkInAt!)}`)
      : p.status === "leave" ? "On leave" : p.status === "absent" ? "Absent" : "Not started yet";
    return { p, ed, kind, line };
  });
  const count = (k: string) => rows.filter((r) => r.kind === k).length;
  const chips = [["working", "Working", "good"], ["break", "On break", "warn"], ["not", "Not started", ""], ["wrapped", "Wrapped up", "ac"]] as const;
  const shown = rows.slice(0, 6);
  if (!rows.length) return <div className="hw-empty">No one on the team yet.</div>;
  return (
    <div className="hw-pad">
      <div className="hw-chips">
        {chips.map(([k, l, t]) => <span key={k} className={"hw-count " + t}><i /><b>{count(k)}</b>{l}</span>)}
      </div>
      <div className="hw-people">
        {shown.map((r) => (
          <div key={r.p.editorId} className="hw-person">
            <span className="hw-person-ava"><Face editor={r.ed} name={r.p.name} size={30} /><i className={"hw-sdot " + r.kind} /></span>
            <span className="hw-person-txt"><b>{r.p.name}</b><span>{r.line}</span></span>
          </div>
        ))}
      </div>
      {rows.length > shown.length && <Link to="/my-team" className="hw-more">+{rows.length - shown.length} more on Team</Link>}
    </div>
  );
}

function GoalPaceW({ c, many }: { c: HomeCtx; many: boolean }) {
  const { rows, avg } = goalPace(c);
  if (!rows.length) return <div className="hw-empty">No goals set for {monthName()} yet.</div>;
  return (
    <div className="hw-pad">
      <b className={"hw-big " + pctTone(avg ?? 0)}>{avg}%</b>
      <p className="hw-note">team average · {monthName()} so far · lowest first</p>
      <div className="hw-bars">
        {rows.slice(0, many ? 8 : 5).map((r) => (
          <div key={r.e.id} className="hw-barrow">
            <span>{r.e.name}</span>
            <span className="hw-track"><i className={pctTone(r.pct)} style={{ width: `${Math.min(100, r.pct)}%` }} /></span>
            <b className="mono">{r.pct}%</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function CapacityW({ c }: { c: HomeCtx }) {
  const d = new Date(c.nowMs);
  const capH = c.cal ? capacityFor(c.cal, d.getFullYear(), d.getMonth()).minutes / 60 : 0;
  const month = c.today.slice(0, 7);
  const rows = teamEditors(c)
    .map((e) => {
      const planned = c.tasks
        .filter((t) => t.editor_id === e.id && t.budget_hours != null && (t.due_date ?? "").slice(0, 7) === month)
        .reduce((s, t) => s + Number(t.budget_hours), 0);
      return { e, planned, pct: capH > 0 ? Math.round((planned / capH) * 100) : 0 };
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
  if (!rows.length) return <div className="hw-empty">No one on the team yet.</div>;
  const tone = (p: number) => (p >= 100 ? "bad" : p >= 85 ? "good" : "warn");
  return (
    <div className="hw-pad">
      <p className="hw-note">{monthName()} · {Math.round(capH)}h per editor · highest load first</p>
      <div className="hw-bars">
        {rows.map((r) => (
          <div key={r.e.id} className="hw-barrow">
            <span>{r.e.name}</span>
            <span className="hw-track"><i className={tone(r.pct)} style={{ width: `${Math.min(100, r.pct)}%` }} /></span>
            <b className="mono">{r.pct}%</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeadlinesW({ c }: { c: HomeCtx }) {
  const list = deadlinesOf(c).slice(0, 5);
  if (!list.length) return <div className="hw-empty">Nothing overdue or due today.</div>;
  return (
    <div className="hw-list">
      {list.map((t) => {
        const ed = c.editors.find((e) => e.id === t.editor_id) ?? null;
        const over = (t.due_date ?? "") < c.today;
        return (
          <button key={t.id} type="button" className="hw-li" onClick={() => c.onOpenTask(t.id)}>
            <Face editor={ed} name={ed?.name ?? "?"} />
            <span className="hw-li-txt"><b>{t.title}</b><span>{[ed?.name ?? "Unassigned", taskRef(t)].filter(Boolean).join(" · ")}</span></span>
            <span className={"hw-tag " + (over ? "bad" : "warn")}>{over ? "Overdue" : "Today"}</span>
          </button>
        );
      })}
    </div>
  );
}

function LeaderW({ c }: { c: HomeCtx }) {
  const rows = topEditorsInRange(c.editors, c.tasks, monthStart(c.today), c.today, 5);
  if (!rows.length) return <div className="hw-empty">No points yet this month.</div>;
  const medal = ["oklch(0.7 0.15 85)", "#9aa4b2", "oklch(0.66 0.12 55)"];
  return (
    <div className="hw-list">
      {rows.map((r, i) => {
        const ed = c.editors.find((e) => e.id === r.editorId) ?? null;
        return (
          <div key={r.editorId} className={"hw-li static" + (r.editorId === c.myEditorId ? " me" : "")}>
            <b className="hw-rank" style={{ color: medal[i] }}>{i + 1}</b>
            <Face editor={ed} name={ed?.name ?? "?"} />
            <span className="hw-li-txt"><b>{ed?.name ?? "—"}</b></span>
            <span className="mono hw-pts">{Math.round(r.points)} pts</span>
          </div>
        );
      })}
    </div>
  );
}

function PerfW({ c, wide }: { c: HomeCtx; wide: boolean }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(c.nowMs);
    d.setDate(d.getDate() - 6 + i);
    return ymd(d);
  });
  const prevFrom = (() => { const d = new Date(days[0] + "T00:00:00"); d.setDate(d.getDate() - 7); return ymd(d); })();
  const pub = c.posts.filter((p) => p.status === "published");
  const cur = pub.filter((p) => p.date >= days[0] && p.date <= days[6]);
  const prev = pub.filter((p) => p.date >= prevFrom && p.date < days[0]);
  const sum = (l: Post[]) => ({
    views: l.reduce((s, p) => s + p.views, 0),
    eng: l.reduce((s, p) => s + p.likes + p.comments + p.shares + p.saves, 0),
    reach: l.reduce((s, p) => s + p.reach, 0),
    n: l.length,
  });
  const a = sum(cur), b = sum(prev);
  const er = (x: typeof a) => (x.reach ? (x.eng / x.reach) * 100 : null);
  const delta = (n: number, o: number) => (o ? Math.round(((n - o) / o) * 100) : null);
  const byDay = days.map((d) => cur.filter((p) => p.date.slice(0, 10) === d).reduce((s, p) => s + p.views, 0));
  const max = Math.max(1, ...byDay);
  const best = [...cur].sort((x, y) => performanceScore(y) - performanceScore(x))[0];
  const kpi = (label: string, v: string, d: number | null, unit = "%") => (
    <span className="hw-kpi"><b>{v}</b><em>{label}</em>{d != null && <i className={d >= 0 ? "good" : "bad"}>{d >= 0 ? "+" : ""}{d}{unit}</i>}</span>
  );
  const erA = er(a), erB = er(b);
  return (
    <div className="hw-pad">
      <div className="hw-kpis">
        {kpi("Views", compactNum(a.views), delta(a.views, b.views))}
        {kpi("Engagement", erA != null ? `${erA.toFixed(1)}%` : "—", erA != null && erB != null ? Math.round((erA - erB) * 10) / 10 : null, "")}
        {kpi("Posts", String(a.n), b.n ? a.n - b.n : null, "")}
      </div>
      {wide && (
        <div className="hw-week">
          {byDay.map((v, i) => (
            <span key={days[i]} title={`${new Date(days[i] + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${compactNum(v)} views`}>
              <i style={{ height: `${Math.max(4, (v / max) * 100)}%` }} className={i === 6 ? "on" : undefined} />
              <em>{new Date(days[i] + "T00:00:00").toLocaleDateString("en-GB", { weekday: "narrow" })}</em>
            </span>
          ))}
        </div>
      )}
      <div className="hw-best">
        <Icon name="trophy" size={18} className="hw-gold" />
        {best ? <span><b>{best.title}</b><em>Best this week · {compactNum(best.views)} views · {compactNum(best.saves)} saves</em></span> : <span><em>No published posts this week yet.</em></span>}
      </div>
    </div>
  );
}

function PipelineW({ c }: { c: HomeCtx }) {
  const p = c.d.pipeline;
  const parts = [
    ["not_started", "Not started", "var(--md-todo)"],
    ["pending", "Pending", "var(--md-pend)"],
    ["in_progress", "In progress", "var(--md-prog)"],
    ["in_review", "In review", "var(--md-rev)"],
    ["completed", "Completed", "var(--md-done)"],
  ] as const;
  const shown = parts.filter(([k]) => k !== "pending" || (p[k] ?? 0) > 0);
  const total = shown.reduce((s, [k]) => s + (p[k] ?? 0), 0);
  return (
    <div className="hw-pad">
      <div className="hw-stack">
        {total > 0 && shown.map(([k, l, col]) => (p[k] ?? 0) > 0 && <i key={k} title={`${l}: ${p[k]}`} style={{ flex: p[k], background: col }} />)}
      </div>
      <div className="hw-tiles">
        {shown.map(([k, l, col]) => (
          <span key={k}><b>{p[k] ?? 0}</b><em><i style={{ background: col }} />{l}</em></span>
        ))}
      </div>
    </div>
  );
}

// ---- Team today (attendance) ----

const PILL: Record<string, { l: string; t: string }> = {
  on_time: { l: "On time", t: "good" }, late: { l: "Late", t: "warn" }, no_sod: { l: "No SOD", t: "bad" },
  waiting: { l: "Not in yet", t: "" }, absent: { l: "Absent", t: "bad" }, leave: { l: "On leave", t: "rev" }, half_day: { l: "Half day", t: "rev" },
};
const ORDER: Record<string, number> = { no_sod: 0, absent: 1, late: 2, waiting: 3, half_day: 4, leave: 5, on_time: 6 };

function AttendW({ c }: { c: HomeCtx }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [nudged, setNudged] = useState<Set<string>>(new Set());
  const att = c.att;
  const team = useMemo(() => [...(att?.team ?? [])].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name)), [att]);
  if (!att) return <div className="hw-empty">Attendance needs the database update first.</div>;
  if (!team.length) return <div className="hw-empty">No one checks in yet.</div>;
  const s = att.settings;
  const counts = [
    ["on time", team.filter((p) => p.status === "on_time").length, "good"],
    ["late", team.filter((p) => p.status === "late").length, "warn"],
    ["no SOD", team.filter((p) => p.status === "no_sod").length, "bad"],
    ["absent", team.filter((p) => p.status === "absent").length, "bad"],
    ["on leave", team.filter((p) => p.status === "leave" || p.status === "half_day").length, "rev"],
  ] as const;
  const at = (hhmm: string) => { const d = new Date(); const [h, m] = hhmm.split(":").map(Number); d.setHours(h, m, 0, 0); return clockTime(d); };
  const meta = (p: TeamPerson) => {
    const r = p.row;
    switch (p.status) {
      case "on_time": return `In ${r?.checkInAt ? clockTime(r.checkInAt) : "—"}${r?.excused ? " · late excused" : r?.markedBy ? " · marked by lead" : ""}`;
      case "late": return `In ${r?.checkInAt ? clockTime(r.checkInAt) : "—"} · +${r?.lateMinutes ?? 0}m · −${p.penalty} pt${p.penalty === 1 ? "" : "s"}`;
      case "no_sod": return `${r?.alertSentAt ? `Alert sent ${clockTime(r.alertSentAt)}` : `Office opened ${att.opening ? at(att.opening) : ""}`}${s.autoAbsentEnabled ? ` · absent at ${at(s.autoAbsentAt)}` : ""}`;
      case "waiting": return att.opening ? `Grace until ${at(minutesToHHMM(toMin(att.opening) + s.graceMinutes))}` : "Office closed today";
      case "absent": return `${r?.reason ? r.reason : r?.markedBy ? "Marked by lead" : `Auto-marked at ${at(s.autoAbsentAt)}`}${p.penalty ? ` · −${p.penalty} pts` : ""}`;
      case "half_day": return r?.reason || "Half-day leave";
      case "leave": return r?.reason || "Approved leave";
    }
  };
  async function run(p: TeamPerson, action: "excuse" | "undo" | "nudge" | "mark" | "correction", body: object | undefined, ok: string) {
    setBusy(p.editorId);
    try {
      await attendanceAction(p.editorId, action, body);
      if (action === "nudge") setNudged((n) => new Set(n).add(p.editorId));
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update attendance.");
    } finally {
      setBusy(null);
    }
  }
  const first = (n: string) => n.split(" ")[0];
  const rows = team.slice(0, 7);
  return (
    <div className="hw-pad">
      <div className="hw-chips">
        {counts.filter(([, n]) => n > 0).map(([l, n, t]) => <span key={l} className={"hw-count soft " + t}><b>{n}</b>{l}</span>)}
      </div>
      <div className="hw-att">
        {rows.map((p) => {
          const pill = PILL[p.status];
          const r = p.row;
          const ed = c.editors.find((e) => e.id === p.editorId) ?? null;
          const canMark = p.status === "no_sod" || p.status === "waiting" || (p.status === "absent" && !r?.markedBy);
          return (
            <div key={p.editorId} className="hw-att-row">
              <Face editor={ed} name={p.name} size={30} />
              <span className="hw-li-txt"><b>{p.name}</b><span>{meta(p)}</span></span>
              <span className={"hw-pill " + pill.t}>{pill.l}</span>
              <span className="hw-att-acts">
                {r?.correctionStatus === "pending" && r.correctionAt && (
                  <>
                    <span className="hw-faint sm">Asks {clockTime(r.correctionAt)}</span>
                    <button type="button" className="hw-mini good" disabled={busy === p.editorId} onClick={() => run(p, "correction", { approve: true }, `${first(p.name)}'s start set to ${clockTime(r.correctionAt!)}`)}>Approve</button>
                    <button type="button" className="hw-mini" disabled={busy === p.editorId} onClick={() => run(p, "correction", { approve: false }, "Correction declined")}>Decline</button>
                  </>
                )}
                {(p.status === "no_sod" || p.status === "waiting") && (
                  nudged.has(p.editorId) || r?.nudgedAt
                    ? <span className="hw-faint sm">Nudged</span>
                    : <button type="button" className="hw-mini" disabled={busy === p.editorId} onClick={() => run(p, "nudge", undefined, `${first(p.name)} nudged to start their day`)}>Nudge</button>
                )}
                {p.status === "late" && (
                  <button type="button" className="hw-mini" title="Remove the late mark and penalty" disabled={busy === p.editorId} onClick={() => run(p, "excuse", undefined, `Late mark excused for ${p.name}`)}>Excuse</button>
                )}
                {r?.markedBy && (
                  <button type="button" className="hw-mini" disabled={busy === p.editorId} onClick={() => run(p, "undo", undefined, `Undone for ${p.name}`)}>Undo</button>
                )}
                {canMark && (
                  <select className="hw-mark" value="" disabled={busy === p.editorId} aria-label={`Mark ${p.name} as`}
                    onChange={(e) => {
                      const v = e.target.value as "working" | "half_day" | "leave" | "absent";
                      if (!v) return;
                      const word = { working: "working now", half_day: "half-day leave", leave: "on leave", absent: "absent" }[v];
                      run(p, "mark", { as: v }, `${p.name} marked as ${word}`);
                    }}>
                    <option value="">Mark as…</option>
                    <option value="working">Working now</option>
                    <option value="half_day">Half-day leave</option>
                    <option value="leave">On leave</option>
                    <option value="absent">Absent</option>
                  </select>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {team.length > rows.length && <Link to="/my-team?tab=attendance" className="hw-more">+{team.length - rows.length} more on Attendance</Link>}
    </div>
  );
}
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const minutesToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
