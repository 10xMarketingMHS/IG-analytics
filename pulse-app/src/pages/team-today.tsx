import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { gradFor } from "@/lib/editor-visuals";
import { ymd } from "@/lib/task-points";
import { breakOffsetMs, DAILY_BREAK_CAP_SEC } from "@/lib/task-timing";
import { achievement, currentPeriod, doneByType, goalLines, monthName, pctText, periodBounds, periodLabel, type PerfRow } from "@/lib/goal-periods";
import type { Editor, Task } from "@/lib/types";
import { exportReport, rankTeam } from "@/pages/team-panel";

// My Team › Today (Pulse Redesign v5): who is working, on a break, not started
// or wrapped up right now, what each person is on and for how long, and — for
// the one picked — today's tasks and where they stand on this half-month's
// goal. Live from today's End of Day sessions (GET /eod/team), the tasks, and
// the break each person's tasks carry; it refreshes itself every minute.

type TeamRow = { id: string; status: "not_started" | "active" | "completed"; startedAt: string | null; endedAt: string | null; workedSeconds: number };
type Tone = "work" | "break" | "idle" | "done";
const TONE_LABEL: Record<Tone, string> = { work: "Working", break: "On break", idle: "Not started", done: "Wrapped up" };
const FILTERS: ("all" | Tone)[] = ["all", "work", "break", "idle", "done"];
const STAGE: Record<Task["status"], { l: string; t: string }> = {
  todo: { l: "To do", t: "" }, in_progress: { l: "In progress", t: "warn" }, review: { l: "In review", t: "rev" }, done: { l: "Completed", t: "good" },
};

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");
const hm = (sec: number) => { const m = Math.max(0, Math.floor(sec / 60)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
function Face({ editor, big, tone }: { editor: Editor; big?: boolean; tone?: Tone }) {
  return (
    <span className={"mt-tface" + (big ? " big" : "")}>
      {editor.image_url ? <img src={editor.image_url} alt="" /> : <span style={{ background: gradFor(editor.name) }}>{initials(editor.name)}</span>}
      {tone && <i className={tone} />}
    </span>
  );
}

type Live = {
  editor: Editor; own: Task[]; tone: Tone; now: string; sub: string;
  doneToday: number; inProgress: number; loggedSec: number; breakUsedSec: number;
};

export function TeamToday({ tasks, editors, onOpenTask, focusId }: {
  tasks: Task[] | null; editors: Editor[] | null; onOpenTask: (t: Task) => void; focusId?: string | null;
}) {
  const navigate = useNavigate();
  const today = ymd(new Date());
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNowMs(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  const { data: eod, refetch } = useResource<{ editors: TeamRow[] }>(`/eod/team?date=${today}`);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  useEffect(() => { setFetchedAt(Date.now()); }, [eod]);
  useEffect(() => { const t = window.setInterval(() => { refetch().catch(() => {}); }, 60_000); return () => window.clearInterval(t); }, [refetch]);
  const [filter, setFilter] = useState<"all" | Tone>("all");
  const [selId, setSelId] = useState<string | null>(focusId ?? null);
  const [exporting, setExporting] = useState(false);

  const people = useMemo((): Live[] => {
    const all = tasks ?? [];
    // Today's roster: whoever End of Day tracks (it leaves admins out).
    const roster = eod
      ? eod.editors.map((r) => (editors ?? []).find((e) => e.id === r.id)).filter((e): e is Editor => !!e)
      : (editors ?? []).filter((e) => e.active && !e.is_admin);
    return roster.map((e) => {
      const own = all.filter((t) => t.editor_id === e.id);
      const day = eod?.editors.find((r) => r.id === e.id);
      // The break rides on each of the person's tasks; it lapses at the day's 75 minutes.
      const withBreak = own.find((t) => t.editor_break_started_at);
      const usedBefore = (withBreak ?? own[0])?.editor_break_used_seconds ?? 0;
      const elapsed = withBreak?.editor_break_started_at ? Math.max(0, (nowMs - new Date(withBreak.editor_break_started_at).getTime()) / 1000) : 0;
      const left = DAILY_BREAK_CAP_SEC - usedBefore - elapsed;
      const onBreak = !!withBreak && left > 0;
      const breakUsedSec = Math.min(DAILY_BREAK_CAP_SEC, usedBefore + (onBreak ? elapsed : 0));
      const running = own.find((t) => t.status === "in_progress" && t.accepted && !t.on_hold && t.budget_started_at && new Date(t.budget_started_at).getTime() <= nowMs);
      const runSec = running ? (nowMs - new Date(running.budget_started_at!).getTime() - breakOffsetMs(running, nowMs)) / 1000 : 0;
      const tone: Tone = onBreak ? "break" : day?.status === "active" ? "work" : day?.status === "completed" ? "done" : "idle";
      const worked = day ? day.workedSeconds + (day.status === "active" ? Math.max(0, (nowMs - fetchedAt) / 1000) : 0) : 0;
      const [now, sub] =
        tone === "break" ? ["On a break", `${Math.ceil(left / 60)} min left · ${Math.round(breakUsedSec / 60)} / 75 min used`]
        : tone === "work" ? (running ? [running.title, `Running ${hm(runSec)}${running.channel_name ? ` · ${running.channel_name}` : ""}`] : ["No task running", `Clocked in ${clock(day?.startedAt ?? null)}`])
        : tone === "done" ? ["Finished for the day", `Logged off ${clock(day?.endedAt ?? null)}`]
        : ["No task started yet", "Not clocked in today"];
      return {
        editor: e, own, tone, now, sub,
        doneToday: own.filter((t) => t.status === "done" && t.completed_at && ymd(new Date(t.completed_at)) === today).length,
        inProgress: own.filter((t) => t.status === "in_progress").length,
        loggedSec: Math.max(0, worked - breakUsedSec), breakUsedSec,
      };
    });
  }, [tasks, editors, eod, nowMs, fetchedAt, today]);

  const shown = people.filter((p) => filter === "all" || p.tone === filter);
  const sel = people.find((p) => p.editor.id === selId) ?? shown[0] ?? people[0] ?? null;

  // The picked person's goal for this half of the month.
  const month = today.slice(0, 7), per = currentPeriod();
  const selEditorId = sel?.editor.id ?? null;
  const [perf, setPerf] = useState<{ id: string; rows: PerfRow[] } | null>(null);
  useEffect(() => {
    if (!selEditorId) return;
    let live = true;
    api<{ rows: PerfRow[] }>(`/goals/performance?editorId=${selEditorId}&month=${month}-01`)
      .then((r) => { if (live) setPerf({ id: selEditorId, rows: r.rows }); })
      .catch(() => { if (live) setPerf({ id: selEditorId, rows: [] }); });
    return () => { live = false; };
  }, [selEditorId, month]);
  const goal = useMemo(() => {
    if (!sel || perf?.id !== sel.editor.id || !perf.rows.length) return null;
    const [from, to] = periodBounds(month, per);
    const lines = goalLines(perf.rows, per, doneByType(tasks ?? [], sel.editor.id, from, to));
    return lines.length ? achievement(lines) : null;
  }, [sel, perf, tasks, month, per]);

  const todays = useMemo(() => {
    if (!sel) return [];
    const order: Record<Task["status"], number> = { in_progress: 0, review: 1, todo: 2, done: 3 };
    return sel.own
      .filter((t) => t.status === "in_progress" || t.status === "review"
        || (t.status === "done" && t.completed_at && ymd(new Date(t.completed_at)) === today)
        || (t.status === "todo" && !!t.due_date && t.due_date <= today))
      .sort((a, b) => order[a.status] - order[b.status]);
  }, [sel, today]);

  async function dayReport() {
    setExporting(true);
    try {
      await exportReport(rankTeam(tasks ?? [], editors ?? [], today, today, today), today, today, today);
      toast.success("Day report downloaded.");
    } catch {
      toast.error("Couldn't create the report.");
    } finally {
      setExporting(false);
    }
  }

  const liveLabel = new Date(nowMs).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  const goalTone = goal ? (goal.x >= 0.8 ? "good" : goal.x >= 0.5 ? "warn" : "bad") : "";

  return (
    <div className="mt">
      <div className="mt-bar">
        <div className="mt-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => {
            const n = f === "all" ? people.length : people.filter((p) => p.tone === f).length;
            return (
              <button key={f} type="button" className={filter === f ? "on" : ""} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                <i className={f} />{f === "all" ? "Everyone" : TONE_LABEL[f]}<span>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-actions">
          <span className="mt-livelbl"><i />Live · {liveLabel}</span>
          <button type="button" className="mt-btn" onClick={dayReport} disabled={exporting || !people.length} title="Download today's report as an Excel file">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
            {exporting ? "Preparing…" : "Day report"}
          </button>
        </div>
      </div>

      {tasks === null || editors === null ? (
        <div className="mt-card mt-empty">Loading…</div>
      ) : people.length === 0 ? (
        <div className="mt-card mt-empty">No team members yet. <Link to="/teams">Add people in Settings</Link>.</div>
      ) : (
        <>
          {shown.length === 0 ? <div className="mt-card mt-empty">Nobody is {TONE_LABEL[filter as Tone].toLowerCase()} right now.</div> : (
            <div className="mt-livegrid">
              {shown.map((p) => {
                const on = sel?.editor.id === p.editor.id;
                return (
                  <button key={p.editor.id} type="button" className={"mt-lcard" + (on ? " on" : "")} onClick={() => setSelId(p.editor.id)} aria-pressed={on}>
                    <span className="mt-lhead">
                      <Face editor={p.editor} tone={p.tone} />
                      <span className="mt-who"><b>{p.editor.name}</b><span>{p.editor.designation || "Team member"}</span></span>
                      <span className={"mt-pill " + p.tone}>{TONE_LABEL[p.tone]}</span>
                    </span>
                    <span className="mt-now"><b>{p.now}</b><span>{p.sub}</span></span>
                    <span className="mt-lfoot"><span><b>{p.doneToday}</b> done today</span><span><b>{hm(p.loggedSec)}</b> logged</span></span>
                  </button>
                );
              })}
            </div>
          )}

          {sel && (
            <div className="mt-row">
              <section className="mt-card mt-profile">
                <div className="mt-phead">
                  <Face editor={sel.editor} big />
                  <span className="mt-who"><b>{sel.editor.name}</b><span>{sel.editor.designation || "Team member"}</span></span>
                </div>
                <div className={"mt-livebox " + sel.tone}><i /><b>{TONE_LABEL[sel.tone]}</b><span>{sel.tone === "work" || sel.tone === "break" ? sel.now : sel.sub}</span></div>
                <div className="mt-kpis">
                  <span><b>{sel.doneToday}</b><span>Done today</span></span>
                  <span><b>{sel.inProgress}</b><span>In progress</span></span>
                  <span><b>{hm(sel.loggedSec)}</b><span>Time logged</span></span>
                  <span><b>{Math.round(sel.breakUsedSec / 60)} / 75m</b><span>Break used</span></span>
                </div>
                <button type="button" className="mt-goalcard" onClick={() => navigate(goal ? `/goals-board?editor=${sel.editor.id}` : "/goals")}>
                  <span className="mt-goalrow">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>
                    <span>Goal · {periodLabel(month, per)}</span><span className="mt-grow" />
                    {goal ? <><b className={goalTone}>{pctText(goal.x)}</b><em>of target</em></> : <em>No goal set</em>}
                  </span>
                  <span className="mt-goalbar"><span className={goalTone} style={{ width: `${goal ? Math.min(100, goal.x * 100) : 0}%` }} /></span>
                  <span className="mt-goalsub">
                    {goal ? `${goal.done} of ${goal.target} jobs · ${goal.missed ? `${goal.missed} goal${goal.missed === 1 ? "" : "s"} to review` : "all goals met"} · open in Goals` : `Set ${monthName(month, "short")} goals in Goal Setting`}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  </span>
                </button>
              </section>

              <section className="mt-card mt-tasks">
                <div className="mt-thead"><b>Today's tasks</b><span>{todays.length} task{todays.length === 1 ? "" : "s"}</span></div>
                {todays.length === 0 ? <div className="mt-none">Nothing on today.</div> : (
                  <div className="mt-scroll">
                    <div className="mt-list today">
                      <div className="mt-lh"><span>Task</span><span>Type</span><span>Stage</span><span>Started</span><span className="num">Time</span></div>
                      {todays.map((t) => {
                        const st = STAGE[t.status];
                        const started = t.budget_started_at && ymd(new Date(t.budget_started_at)) === today ? clock(t.budget_started_at) : "–";
                        const runningNow = t.status === "in_progress" && t.accepted && !t.on_hold && t.budget_started_at && new Date(t.budget_started_at).getTime() <= nowMs;
                        const time = runningNow ? hm((nowMs - new Date(t.budget_started_at!).getTime() - breakOffsetMs(t, nowMs)) / 1000)
                          : t.status === "done" ? `Done ${clock(t.completed_at)}` : t.on_hold ? "On hold" : "–";
                        return (
                          <div key={t.id} className="mt-lr" role="button" tabIndex={0} onClick={() => onOpenTask(t)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTask(t); } }} title="Open the task">
                            <span className="mt-ttl"><span className="mt-ref">{t.tid ?? ""}</span><b>{t.title}</b></span>
                            <span className="mt-sub">{t.content_format_name ?? "–"}</span>
                            <span><span className={"mt-stage " + (t.on_hold ? "warn" : st.t)}>{t.on_hold ? "On hold" : st.l}</span></span>
                            <span className="mt-sub">{started}</span>
                            <span className="num mt-mono">{time}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

