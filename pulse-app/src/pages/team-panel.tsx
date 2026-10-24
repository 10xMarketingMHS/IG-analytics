import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useResource } from "@/lib/use-resource";
import { ymd, lateDays, taskPoints, isScorableTask, countsInTaskScore } from "@/lib/task-points";
import { gradFor } from "@/lib/editor-visuals";
import { DAILY_BREAK_CAP_SEC } from "@/lib/task-timing";
import type { Editor, Task } from "@/lib/types";
import "./my-team.css";
import { clockTime } from "@/lib/time-format";
import { webLink } from "@/lib/csv";

// The body of the admin-only My Team page (Pulse Redesign v5, Team): every team
// member as a card, ranked by Task Points for a chosen date range, with what
// they're doing right now; for the one selected, their profile — points, on-time
// rate, sent back, this month's goal — and every task in that range with the
// same details the Excel report carries: the main columns in the list, the rest
// in a row that expands on click.
//
// Which period a task belongs to: a finished task counts on the day it was
// completed (so points land in the period they were earned); an unfinished one
// counts on its due date (so open work shows in the period it's expected). An
// unfinished task with no due date counts as today's.

type TeamRow = { id: string; status: "not_started" | "active" | "completed"; startedAt: string | null; endedAt: string | null };
type RangeKey = "today" | "week" | "lastweek" | "month" | "custom";

const STAGES = ["To Do", "In Progress", "Review", "Completed"] as const;
const STAGE_INDEX: Record<Task["status"], number> = { todo: 0, in_progress: 1, review: 2, done: 3 };
const CATEGORY: Record<string, string> = {
  social: "Social", ad: "Ads", service: "Service", project: "Project", admin: "Admin",
  content: "Content", short_task: "Short task", general: "General",
};

function presetRange(key: Exclude<RangeKey, "custom">, now: Date): [string, string] {
  const today = ymd(now);
  if (key === "today") return [today, today];
  if (key === "week" || key === "lastweek") {
    // Monday to Sunday of the current week (or the one before it).
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (key === "lastweek" ? 7 : 0));
    const end = new Date(d);
    end.setDate(end.getDate() + 6);
    return [ymd(d), ymd(end)];
  }
  return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
}

function fmtDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function fmtClock(iso: string | null) {
  return iso ? clockTime(iso) : "";
}
const fmtPts = (n: number) => (Math.round(n * 10) / 10).toString();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The day a task belongs to, per the rule above.
function taskDay(t: Task, today: string): string {
  if (t.status === "done" && t.completed_at) return ymd(new Date(t.completed_at));
  return t.due_date ?? today;
}

// Days past the due date — at completion for a finished task, as of now for an
// open one — leaving out any time it spent waiting for a reviewer (the same
// lateness the points use). 0 when on time or when there is no due date.
function daysLate(t: Task): number {
  return Math.max(0, lateDays(t));
}

export type RankedRow = { editor: Editor; tasks: Task[]; points: number; done: number; open: number; late: number; scored: boolean };

// Everyone on the active roster with their tasks in the range, ranked: points,
// then tasks completed, then name. (My Team's Ranking and Today's Day report.)
// People a Super Admin switched out of the task score still show,
// with their work, after everyone ranked — but never with a rank.
export function rankTeam(tasks: Task[], editors: Editor[], from: string, to: string, today: string): RankedRow[] {
  return editors
    .filter((e) => e.active)
    .map((e) => {
      const own = tasks
        .filter((t) => t.editor_id === e.id)
        .filter((t) => { const d = taskDay(t, today); return d >= from && d <= to; })
        .sort((a, b) => taskDay(b, today).localeCompare(taskDay(a, today)));
      const done = own.filter((t) => t.status === "done");
      const open = own.filter((t) => t.status !== "done");
      return {
        editor: e,
        tasks: own,
        points: done.filter(isScorableTask).reduce((s, t) => s + taskPoints(t), 0),
        done: done.length,
        open: open.length,
        late: open.filter((t) => lateDays(t) > 0).length,
        scored: countsInTaskScore(e),
      };
    })
    .sort((a, b) => Number(b.scored) - Number(a.scored)
      || (a.scored ? b.points - a.points || b.done - a.done : 0)
      || a.editor.name.localeCompare(b.editor.name));
}

// The report for a weekly or month-end meeting: exactly what the panel shows for
// the chosen dates, as an Excel file — a Summary sheet (one row per person, in
// rank order), an All tasks sheet, and a sheet per person with every task in
// full, including the link to the finished work. The Excel library is loaded
// only when someone actually exports.
export async function exportReport(ranked: RankedRow[], from: string, to: string, today: string) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const period = from === to ? from : `${from} to ${to}`;

  const summary = wb.addWorksheet("Summary");
  summary.addRow([`Pulse team report — ${period}`]).font = { bold: true, size: 13 };
  summary.addRow([`Exported ${today}. Finished tasks count on the day they were completed; unfinished tasks count on their due date.`]);
  summary.addRow([]);
  summary.addRow(["Rank", "Employee", "Designation", "Points", "Completed", "Open", "Late"]).font = { bold: true };
  ranked.forEach((r, i) => summary.addRow([
    r.scored ? i + 1 : "Exempt", r.editor.name, r.editor.designation ?? "", Math.round(r.points * 10) / 10, r.done, r.open, r.late,
  ]));
  summary.columns.forEach((c, i) => { c.width = [11, 28, 22, 10, 12, 10, 10][i] ?? 12; });

  // Every detail of one task, as a row. The work link is a real hyperlink so a
  // completed task's output opens straight from the sheet.
  const COLUMNS: [string, number][] = [
    ["Task ID", 12], ["Other ID", 12], ["Title", 40], ["Description", 50], ["Category", 12],
    ["Content type", 16], ["Brand", 16], ["Priority", 10], ["Stage", 14], ["Assigned on", 13],
    ["Due date", 12], ["Completed on", 14], ["Days late", 10], ["Times sent back", 15],
    ["Points", 8], ["Work link", 48], ["Other links", 48], ["Note", 26], ["Self-created", 12],
  ];
  const cellsFor = (t: Task) => {
    const done = t.status === "done";
    return [
      t.tid ?? "", t.sid ?? t.ad_id ?? t.svid ?? t.pid ?? "", t.title, t.description ?? "",
      CATEGORY[t.task_type] ?? t.task_type, t.content_format_name ?? "", t.channel_name ?? "",
      t.priority.charAt(0).toUpperCase() + t.priority.slice(1), STAGES[STAGE_INDEX[t.status]],
      ymd(new Date(t.created_at)), t.due_date ?? "",
      done && t.completed_at ? ymd(new Date(t.completed_at)) : "",
      daysLate(t), Math.max(0, (t.revision ?? 1) - 1),
      done && isScorableTask(t) ? Math.round(taskPoints(t) * 10) / 10 : "",
      webLink(t.delivery_link) ? { text: t.delivery_link, hyperlink: t.delivery_link } : t.delivery_link ?? "",
      (t.attachments ?? []).map((a) => (a.label ? `${a.label}: ${a.url}` : a.url)).join("\n"),
      taskNote(t, today).text,
      t.self_created ? "Yes" : "",
    ];
  };
  const styleLinks = (ws: { getColumn: (n: number) => { eachCell: (fn: (c: { value: unknown; font: unknown }) => void) => void } }, col: number) =>
    ws.getColumn(col).eachCell((c) => {
      if (c.value && typeof c.value === "object") c.font = { color: { argb: "FF1D4ED8" }, underline: true };
    });

  // Everyone's tasks in one place, for sorting and filtering.
  const all = wb.addWorksheet("All tasks");
  all.addRow(["Employee", ...COLUMNS.map((c) => c[0])]).font = { bold: true };
  for (const r of ranked) for (const t of r.tasks) all.addRow([r.editor.name, ...cellsFor(t)]);
  all.columns.forEach((c, i) => { c.width = i === 0 ? 22 : COLUMNS[i - 1][1]; });
  styleLinks(all, 17);
  all.views = [{ state: "frozen", ySplit: 1 }];

  // One sheet per person: their totals for the period, then every task in full.
  const used = new Set(["summary", "all tasks"]);
  for (const r of ranked) {
    // Excel sheet names: 31 characters at most, none of \ / ? * [ ] : and no repeats.
    const base = r.editor.name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Employee";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    used.add(name.toLowerCase());

    const ws = wb.addWorksheet(name);
    ws.addRow([`${r.editor.name}${r.editor.designation ? ` — ${r.editor.designation}` : ""}`]).font = { bold: true, size: 13 };
    ws.addRow([`Period: ${period}`]);
    ws.addRow([`Points: ${Math.round(r.points * 10) / 10}   Completed: ${r.done}   Open: ${r.open}   Late: ${r.late}`]);
    ws.addRow([]);
    ws.addRow(COLUMNS.map((c) => c[0])).font = { bold: true };
    if (r.tasks.length === 0) ws.addRow(["No tasks in this period."]);
    for (const t of r.tasks) ws.addRow(cellsFor(t));
    ws.columns.forEach((c, i) => { c.width = COLUMNS[i]?.[1] ?? 12; });
    styleLinks(ws, 16);
    ws.views = [{ state: "frozen", ySplit: 5 }];
  }

  const blob = new Blob([await wb.xlsx.writeBuffer()], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pulse-team-report-${from === to ? from : `${from}_to_${to}`}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// The one thing worth saying about a task, and its tone.
function taskNote(t: Task, today: string): { text: string; tone: "good" | "warn" | "bad" | "plain" } {
  if (t.status === "done") {
    const late = lateDays(t);
    const earned = taskPoints(t);
    const pts = isScorableTask(t) ? ` · ${earned >= 0 ? "+" : ""}${fmtPts(earned)} ${Math.abs(earned) === 1 ? "pt" : "pts"}` : "";
    return late > 0 ? { text: `${plural(late, "day")} late${pts}`, tone: "bad" } : { text: `On time${pts}`, tone: "good" };
  }
  if (t.on_hold) return { text: "On hold", tone: "warn" };
  if (t.status === "review") return { text: "Waiting for review", tone: "warn" };
  const late = lateDays(t);
  if (late > 0) return { text: `${plural(late, "day")} late`, tone: "bad" };
  if (t.status === "todo" && !t.accepted) return { text: "Not accepted yet", tone: "warn" };
  if (!t.due_date) return { text: "No due date", tone: "plain" };
  return { text: t.due_date === today ? "Due today" : `Due ${fmtDay(t.due_date)}`, tone: "plain" };
}

// Live line under each person: on break, working on something, finished, or
// not started — from today's End of Day state and the break their tasks carry.
type Live = { tone: "work" | "break" | "idle" | "done" | "none"; text: string };
function liveStatus(own: Task[], day: TeamRow | undefined, nowMs: number): Live {
  const onBreak = own.find((t) => t.editor_break_started_at);
  if (onBreak?.editor_break_started_at) {
    const elapsed = (nowMs - new Date(onBreak.editor_break_started_at).getTime()) / 1000;
    const left = DAILY_BREAK_CAP_SEC - (onBreak.editor_break_used_seconds ?? 0) - Math.max(0, elapsed);
    if (left > 0) return { tone: "break", text: `On break · ${Math.ceil(left / 60)} min left` };
  }
  if (day?.status === "completed") return { tone: "done", text: `Finished at ${fmtClock(day.endedAt)}` };
  if (day?.status === "active") {
    const cur = own.find((t) => t.status === "in_progress" && t.accepted && !t.on_hold && t.budget_started_at && new Date(t.budget_started_at).getTime() <= nowMs);
    return { tone: "work", text: cur ? `Working on ${cur.title}` : `Working since ${fmtClock(day.startedAt)}` };
  }
  if (day?.status === "not_started") return { tone: "idle", text: "Not started today" };
  return { tone: "none", text: "" };
}

// The stage, as the board names it, and its colour.
function stageOf(t: Task): { label: string; tone: "todo" | "prog" | "rev" | "done" | "bad" | "warn" } {
  if (t.status === "done") return { label: "Completed", tone: "done" };
  if ((t.revision ?? 1) > 1) return { label: "Sent back", tone: "bad" };
  if (t.on_hold) return { label: "On hold", tone: "warn" };
  if (t.status === "review") return { label: "In review", tone: "rev" };
  if (t.status === "in_progress") return { label: "In progress", tone: "prog" };
  return { label: "To do", tone: "todo" };
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
function Face({ editor, big }: { editor: Editor; big?: boolean }) {
  const cls = "mt-face" + (big ? " big" : "");
  return editor.image_url
    ? <img className={cls} src={editor.image_url} alt="" />
    : <span className={cls} style={{ background: gradFor(editor.name) }}>{initials(editor.name)}</span>;
}

const ICON_DOWNLOAD = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
);
const ICON_ARROW = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

export function TeamPanel({ tasks, editors, onOpenTask, focusId }: {
  tasks: Task[] | null; editors: Editor[] | null; onOpenTask: (t: Task) => void; focusId?: string | null;
}) {
  const today = ymd(new Date());
  const [rangeKey, setRangeKey] = useState<RangeKey>("month");
  const [custom, setCustom] = useState<[string, string]>(() => presetRange("month", new Date()));
  const [from, to] = rangeKey === "custom" ? custom : presetRange(rangeKey, new Date());
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const [exporting, setExporting] = useState(false);
  // The task row whose extra details are showing (one at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: eod } = useResource<{ editors: TeamRow[] }>(`/eod/team?date=${today}`);
  // This month's goal per person (Goal Setting), the same figure the Leaderboard shows.
  const { data: goalData } = useResource<{ totals: { editorId: string; goalPoints: number }[] }>(`/goals/totals?month=${today.slice(0, 7)}-01`);

  const ranked = useMemo(() => rankTeam(tasks ?? [], editors ?? [], from, to, today), [tasks, editors, from, to, today]);

  // Points earned this calendar month, for the goal bar whatever range is picked.
  const monthPoints = useMemo(() => {
    const [mf, mt] = presetRange("month", new Date());
    const m = new Map<string, number>();
    for (const t of tasks ?? []) {
      if (t.status !== "done" || !t.editor_id || !isScorableTask(t)) continue;
      const d = taskDay(t, today);
      if (d >= mf && d <= mt) m.set(t.editor_id, (m.get(t.editor_id) ?? 0) + taskPoints(t));
    }
    return m;
  }, [tasks, today]);

  const nowMs = Date.now();
  const liveOf = (id: string) => liveStatus((tasks ?? []).filter((t) => t.editor_id === id), eod?.editors.find((r) => r.id === id), nowMs);

  const selectedIndex = Math.max(0, ranked.findIndex((r) => r.editor.id === selectedId));
  const selected = ranked[selectedIndex] ?? null;

  const rangeLabel = from === to ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(to)}`;
  const rangeWord = { today: "today", week: "this week", lastweek: "last week", month: "this month", custom: rangeLabel }[rangeKey];
  const PRESETS: { key: Exclude<RangeKey, "custom">; label: string }[] = [
    { key: "today", label: "Today" }, { key: "week", label: "This week" },
    { key: "lastweek", label: "Last week" }, { key: "month", label: "This month" },
  ];
  async function onExport() {
    setExporting(true);
    try {
      await exportReport(ranked, from, to, today);
      toast.success("Report downloaded.");
    } catch {
      toast.error("Couldn't create the report.");
    } finally {
      setExporting(false);
    }
  }
  function setCustomDate(i: 0 | 1, value: string) {
    if (!value) return;
    const next: [string, string] = i === 0 ? [value, to] : [from, value];
    // Keep the range the right way round whichever end was moved.
    if (next[0] > next[1]) next[i === 0 ? 1 : 0] = value;
    setCustom(next);
    setRangeKey("custom");
  }

  const doneTasks = selected ? selected.tasks.filter((t) => t.status === "done") : [];
  const onTime = doneTasks.length ? Math.round((doneTasks.filter((t) => lateDays(t) <= 0).length / doneTasks.length) * 100) : null;
  const sentBackTotal = selected ? selected.tasks.reduce((s, t) => s + Math.max(0, (t.revision ?? 1) - 1), 0) : 0;
  const goal = selected ? goalData?.totals.find((g) => g.editorId === selected.editor.id)?.goalPoints ?? 0 : 0;
  const monthPts = selected ? monthPoints.get(selected.editor.id) ?? 0 : 0;
  const live = selected ? liveOf(selected.editor.id) : null;

  return (
    <div className="mt">
      <div className="mt-bar">
        <div className="mt-seg" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={rangeKey === p.key ? "on" : ""} onClick={() => setRangeKey(p.key)}>{p.label}</button>
          ))}
          <button type="button" className={rangeKey === "custom" ? "on" : ""} onClick={() => { setCustom([from, to]); setRangeKey("custom"); }}>Custom</button>
        </div>
        {rangeKey === "custom" ? (
          <div className="mt-dates">
            <input type="date" aria-label="From date" value={from} max={to} onChange={(e) => setCustomDate(0, e.target.value)} />
            <span>to</span>
            <input type="date" aria-label="To date" value={to} min={from} onChange={(e) => setCustomDate(1, e.target.value)} />
          </div>
        ) : <span className="mt-range">{rangeLabel}</span>}
        <div className="mt-actions">
          <Link to="/leaderboard" className="mt-btn ghost">Leaderboard{ICON_ARROW}</Link>
          <button type="button" className="mt-btn" disabled={exporting || ranked.length === 0} onClick={onExport} title={`Download an Excel report for ${rangeLabel}`}>
            {ICON_DOWNLOAD}{exporting ? "Preparing…" : "Excel report"}
          </button>
        </div>
      </div>

      {tasks === null || editors === null ? (
        <div className="mt-card mt-empty">Loading…</div>
      ) : ranked.length === 0 ? (
        <div className="mt-card mt-empty">No team members yet. <Link to="/my-team?tab=roster">Add people on the Roster</Link>.</div>
      ) : (
        <>
          <div className="mt-people" role="tablist" aria-label={`Team ranking, ${rangeLabel}`}>
            {ranked.map((r, i) => {
              const on = selected?.editor.id === r.editor.id;
              const lv = liveOf(r.editor.id);
              return (
                <button key={r.editor.id} type="button" role="tab" aria-selected={on} className={"mt-person" + (on ? " on" : "")}
                  onClick={() => { setSelectedId(r.editor.id); setExpandedId(null); }}>
                  <span className="mt-ptop"><Face editor={r.editor} /><span className="mt-grow" />{r.scored
                    ? <b className={"mt-rank" + (i === 0 && r.points > 0 ? " first" : "")}>#{i + 1}</b>
                    : <b className="mt-rank off" title="Exempt from task scoring — a Super Admin can change this on Team › Roster">Exempt</b>}</span>
                  <span className="mt-who"><b>{r.editor.name}</b><span>{r.editor.designation || "Team member"}</span></span>
                  <span className="mt-pts"><b>{fmtPts(r.points)}</b><span>pts · {r.done} done{r.late > 0 && <em> · {r.late} late</em>}</span></span>
                  <span className={"mt-live " + lv.tone}><i />{lv.text || `${r.open} open`}</span>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="mt-row">
              <section className="mt-card mt-profile">
                <div className="mt-phead">
                  <Face editor={selected.editor} big />
                  <span className="mt-who"><b>{selected.editor.name}</b><span>{selected.editor.designation || "Team member"} · {selected.scored ? `#${selectedIndex + 1} ${rangeWord}` : "exempt from task scoring"}</span></span>
                </div>
                {live && live.text && <div className={"mt-livebox " + live.tone}><i />{live.text}</div>}
                <div className="mt-kpis">
                  <span><b>{fmtPts(selected.points)}</b><span>Points {rangeWord}</span></span>
                  <span><b>{selected.done}</b><span>Completed</span></span>
                  <span><b className={onTime == null ? "" : onTime >= 90 ? "good" : onTime < 80 ? "warn" : ""}>{onTime == null ? "–" : `${onTime}%`}</b><span>On time</span></span>
                  <span><b className={sentBackTotal > 3 ? "bad" : ""}>{sentBackTotal}</b><span>Sent back</span></span>
                </div>
                <div className="mt-goal">
                  <span><span>Monthly goal points</span><b>{goal > 0 ? `${fmtPts(monthPts)} / ${fmtPts(goal)}` : "No goal set"}</b></span>
                  <span className="mt-goalbar"><span style={{ width: `${goal > 0 ? Math.min(100, (monthPts / goal) * 100) : 0}%` }} /></span>
                </div>
              </section>

              <section className="mt-card mt-tasks">
                <div className="mt-thead">
                  <b>Tasks</b>
                  <span>{plural(selected.tasks.length, "task")} · {selected.open} open{selected.late > 0 && <em> · {selected.late} late</em>}</span>
                  <span className="mt-grow" />
                  <span className="mt-range">{rangeLabel}</span>
                </div>
                {selected.tasks.length === 0 ? (
                  <div className="mt-none">No tasks in this period.</div>
                ) : (
                  <div className="mt-scroll">
                    <div className="mt-list">
                      <div className="mt-lh">
                        <span>Task</span><span>Type</span><span>Stage</span><span>Due</span><span>Done</span>
                        <span className="num">Sent back</span><span className="num">Pts</span><span className="num">Work</span>
                      </div>
                      {selected.tasks.map((t) => {
                        const stage = STAGE_INDEX[t.status];
                        const st = stageOf(t);
                        const note = taskNote(t, today);
                        const done = t.status === "done";
                        const late = daysLate(t);
                        const sentBack = Math.max(0, (t.revision ?? 1) - 1);
                        const open = expandedId === t.id;
                        const otherId = t.sid ?? t.ad_id ?? t.svid ?? t.pid;
                        const pts = done && isScorableTask(t) ? taskPoints(t) : null;
                        const toggle = () => setExpandedId(open ? null : t.id);
                        return (
                          <Fragment key={t.id}>
                            <div
                              className={"mt-lr" + (open ? " open" : "")} role="button" tabIndex={0} aria-expanded={open}
                              title={open ? "Hide the details" : "Show all the details"}
                              onClick={toggle}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                            >
                              <span className="mt-ttl">
                                <span className="mt-ref">{t.tid ?? ""}{t.self_created && <span className="mt-self" title="Created by the assignee for themselves">Self-created</span>}</span>
                                <b>{t.title}</b>
                              </span>
                              <span className="mt-sub">{t.content_format_name ?? "–"}</span>
                              <span><span className={"mt-stage " + st.tone}>{st.label}</span></span>
                              <span className={late > 0 ? "mt-late" : "mt-sub"}>{t.due_date ? fmtDay(t.due_date) : "–"}{late > 0 && <em>{plural(late, "day")} late</em>}</span>
                              <span className="mt-sub">{done && t.completed_at ? fmtDay(ymd(new Date(t.completed_at))) : "–"}</span>
                              <span className="num mt-sub">{sentBack > 0 ? sentBack : "–"}</span>
                              <b className={"num " + (pts == null ? "mt-sub" : pts >= 0 ? "mt-good" : "mt-bad")}>{pts == null ? "–" : `${pts >= 0 ? "+" : ""}${fmtPts(pts)}`}</b>
                              <span className="num">
                                {t.delivery_link ? (
                                  <a href={t.delivery_link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open ↗</a>
                                ) : <span className="mt-sub">–</span>}
                              </span>
                            </div>
                            {open && (
                              <div className="mt-more">
                                <div className="mt-moregrid">
                                  <div><span>Description</span>{t.description?.trim() || "None"}</div>
                                  <div><span>Category and brand</span>{[CATEGORY[t.task_type] ?? t.task_type, t.channel_name].filter(Boolean).join(" · ")}</div>
                                  <div><span>Priority</span>{t.priority.charAt(0).toUpperCase() + t.priority.slice(1)}</div>
                                  <div><span>Assigned</span>{fmtDay(ymd(new Date(t.created_at)))}</div>
                                  <div><span>Other ID</span>{otherId ?? "None"}</div>
                                  <div>
                                    <span>Other links</span>
                                    {(t.attachments ?? []).length === 0 ? "None" : (t.attachments ?? []).map((a) => (
                                      <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer">{a.label || a.url} ↗</a>
                                    ))}
                                  </div>
                                  <div><span>Note</span>{note.text}</div>
                                </div>
                                <div className="mt-progress">
                                  <span className="mt-steps" aria-hidden>
                                    {STAGES.map((s, k) => <span key={s} className={k <= stage ? "done" : ""} />)}
                                  </span>
                                  <span className="mt-labels">
                                    {STAGES.map((s, k) => <span key={s} className={k === stage ? "cur" : ""}>{s}</span>)}
                                  </span>
                                </div>
                                <button type="button" className="mt-btn" onClick={() => onOpenTask(t)}>Open task</button>
                              </div>
                            )}
                          </Fragment>
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
