import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useResource } from "@/lib/use-resource";
import { ymd, lateDays, taskPoints, isScorableTask } from "@/lib/task-points";
import { Avatar } from "@/lib/editor-visuals";
import type { Editor, Task } from "@/lib/types";

// The body of the admin-only My Team page: every team member ranked by Task
// Points for a chosen date range, and — for the one selected — every task in
// that range with the same details the Excel report carries: the main columns
// in a table, the rest in a row that expands on click.
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
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
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

type RankedRow = { editor: Editor; tasks: Task[]; points: number; done: number; open: number; late: number };

// The report for a weekly or month-end meeting: exactly what the panel shows for
// the chosen dates, as an Excel file — a Summary sheet (one row per person, in
// rank order), an All tasks sheet, and a sheet per person with every task in
// full, including the link to the finished work. The Excel library is loaded
// only when someone actually exports.
async function exportReport(ranked: RankedRow[], from: string, to: string, today: string) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const period = from === to ? from : `${from} to ${to}`;

  const summary = wb.addWorksheet("Summary");
  summary.addRow([`Pulse team report — ${period}`]).font = { bold: true, size: 13 };
  summary.addRow([`Exported ${today}. Finished tasks count on the day they were completed; unfinished tasks count on their due date.`]);
  summary.addRow([]);
  summary.addRow(["Rank", "Employee", "Designation", "Points", "Completed", "Open", "Late"]).font = { bold: true };
  ranked.forEach((r, i) => summary.addRow([
    i + 1, r.editor.name, r.editor.designation ?? "", Math.round(r.points * 10) / 10, r.done, r.open, r.late,
  ]));
  summary.columns.forEach((c, i) => { c.width = [8, 28, 22, 10, 12, 10, 10][i] ?? 12; });

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
      t.delivery_link ? { text: t.delivery_link, hyperlink: t.delivery_link } : "",
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

export function TeamPanel({ tasks, editors, onOpenTask }: {
  tasks: Task[] | null; editors: Editor[] | null; onOpenTask: (t: Task) => void;
}) {
  const today = ymd(new Date());
  const [rangeKey, setRangeKey] = useState<RangeKey>("month");
  const [custom, setCustom] = useState<[string, string]>(() => presetRange("month", new Date()));
  const [from, to] = rangeKey === "custom" ? custom : presetRange(rangeKey, new Date());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // The task row whose extra details are showing (one at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: eod } = useResource<{ editors: TeamRow[] }>(`/eod/team?date=${today}`);

  // Everyone on the active roster, ranked: points, then tasks completed, then name.
  const ranked = useMemo((): RankedRow[] => {
    const all = tasks ?? [];
    return (editors ?? [])
      .filter((e) => e.active)
      .map((e) => {
        const own = all
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
        };
      })
      .sort((a, b) => b.points - a.points || b.done - a.done || a.editor.name.localeCompare(b.editor.name));
  }, [tasks, editors, from, to, today]);

  const selected = ranked.find((r) => r.editor.id === selectedId) ?? ranked[0] ?? null;
  const day = selected ? eod?.editors.find((r) => r.id === selected.editor.id) : undefined;
  const dayText = !day ? ""
    : day.status === "active" ? `Working since ${fmtClock(day.startedAt)}`
    : day.status === "completed" ? `Finished at ${fmtClock(day.endedAt)}`
    : "Not started today";

  const rangeLabel = from === to ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(to)}`;
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

  return (
    <div className="card myday-panel tmp">
      <div className="mp-head">
        <h3><span className="mp-ic">🏅</span> Ranking and progress</h3>
        <Link to="/leaderboard" className="mp-link">Leaderboard →</Link>
      </div>

      <div className="tmp-bar">
        <div className="seg" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={rangeKey === p.key ? "on" : ""} onClick={() => setRangeKey(p.key)}>{p.label}</button>
          ))}
          <button type="button" className={rangeKey === "custom" ? "on" : ""} onClick={() => { setCustom([from, to]); setRangeKey("custom"); }}>Custom</button>
        </div>
        <div className="tmp-dates">
          <input className="t" type="date" aria-label="From date" value={from} max={to} onChange={(e) => setCustomDate(0, e.target.value)} />
          <span>to</span>
          <input className="t" type="date" aria-label="To date" value={to} min={from} onChange={(e) => setCustomDate(1, e.target.value)} />
        </div>
        <button
          type="button" className="btn btn-primary tmp-export"
          disabled={exporting || ranked.length === 0}
          onClick={onExport}
          title={`Download an Excel report for ${rangeLabel}`}
        >
          {exporting ? "Preparing…" : "⬇ Export .xlsx"}
        </button>
      </div>

      {tasks === null || editors === null ? (
        <div className="home-empty">Loading…</div>
      ) : ranked.length === 0 ? (
        <div className="home-empty">No team members yet. <Link to="/teams">Add people in Settings</Link>.</div>
      ) : (
        <>
          <div className="tmp-people" role="tablist" aria-label={`Team ranking, ${rangeLabel}`}>
            {ranked.map((r, i) => (
              <button
                key={r.editor.id} type="button" role="tab" aria-selected={selected?.editor.id === r.editor.id}
                className={"tmp-person" + (selected?.editor.id === r.editor.id ? " on" : "")}
                onClick={() => { setSelectedId(r.editor.id); setExpandedId(null); }}
              >
                <span className="tmp-rank">{i + 1}</span>
                <Avatar editor={r.editor} />
                <span className="tmp-who">
                  <span className="tmp-name">{r.editor.name}</span>
                  <span className="tmp-meta">
                    {fmtPts(r.points)} pts · {r.done} done · {r.open} open{r.late > 0 && <b className="tmp-latecount"> · {r.late} late</b>}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {selected && (
            <div className="tmp-detail">
              <div className="tmp-colhead">
                {selected.editor.name}{selected.editor.designation ? ` · ${selected.editor.designation}` : ""}
                <span>{[rangeLabel, dayText].filter(Boolean).join(" · ")}</span>
              </div>
              <div className="tmp-stats">
                <div><b>{fmtPts(selected.points)}</b><span>Points</span></div>
                <div><b>{selected.done}</b><span>Completed</span></div>
                <div><b>{selected.open}</b><span>Open</span></div>
                <div className={selected.late > 0 ? "bad" : ""}><b>{selected.late}</b><span>Late</span></div>
              </div>
              {selected.tasks.length === 0 ? (
                <div className="home-empty">No tasks in this period.</div>
              ) : (
                <div className="tmp-scroll">
                  <table className="tmp-table">
                    <thead>
                      <tr>
                        <th>Task</th><th>Type</th><th>Stage</th><th>Assigned</th><th>Due</th><th>Completed</th>
                        <th>Late</th><th>Sent back</th><th>Points</th><th>Work</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.tasks.map((t) => {
                        const stage = STAGE_INDEX[t.status];
                        const note = taskNote(t, today);
                        const done = t.status === "done";
                        const late = daysLate(t);
                        const sentBack = Math.max(0, (t.revision ?? 1) - 1);
                        const open = expandedId === t.id;
                        const otherId = t.sid ?? t.ad_id ?? t.svid ?? t.pid;
                        const toggle = () => setExpandedId(open ? null : t.id);
                        return (
                          <Fragment key={t.id}>
                            <tr
                              className={"tmp-tr" + (open ? " open" : "")} tabIndex={0} aria-expanded={open}
                              title={open ? "Hide the details" : "Show all the details"}
                              onClick={toggle}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                            >
                              <td className="tmp-td-task">
                                <span className="tmp-name">{t.title}{t.self_created && <span className="self-chip" title="Created by the assignee for themselves">🙋 Self-created</span>}</span>
                                <span className="tmp-meta">{t.tid ?? ""}</span>
                              </td>
                              <td>{t.content_format_name ?? "–"}</td>
                              <td><span className={"tmp-note " + note.tone}>{STAGES[stage]}</span></td>
                              <td>{fmtDay(ymd(new Date(t.created_at)))}</td>
                              <td>{t.due_date ? fmtDay(t.due_date) : "–"}</td>
                              <td>{done && t.completed_at ? fmtDay(ymd(new Date(t.completed_at))) : "–"}</td>
                              <td className={late > 0 ? "tmp-latecount" : ""}>{late > 0 ? plural(late, "day") : "–"}</td>
                              <td>{sentBack > 0 ? sentBack : "–"}</td>
                              <td>{done && isScorableTask(t) ? fmtPts(taskPoints(t)) : "–"}</td>
                              <td>
                                {t.delivery_link ? (
                                  <a href={t.delivery_link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open ↗</a>
                                ) : "–"}
                              </td>
                            </tr>
                            {open && (
                              <tr className="tmp-more">
                                <td colSpan={10}>
                                  {/* Pinned to the visible width, so nothing hides off to the right when the table scrolls sideways. */}
                                  <div className="tmp-morein">
                                  <div className="tmp-moregrid">
                                    <div><span>Description</span>{t.description?.trim() || "None"}</div>
                                    <div><span>Category and brand</span>{[CATEGORY[t.task_type] ?? t.task_type, t.channel_name].filter(Boolean).join(" · ")}</div>
                                    <div><span>Priority</span>{t.priority.charAt(0).toUpperCase() + t.priority.slice(1)}</div>
                                    <div><span>Other ID</span>{otherId ?? "None"}</div>
                                    <div>
                                      <span>Other links</span>
                                      {(t.attachments ?? []).length === 0 ? "None" : (t.attachments ?? []).map((a) => (
                                        <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer">{a.label || a.url} ↗</a>
                                      ))}
                                    </div>
                                    <div><span>Note</span>{note.text}</div>
                                  </div>
                                  <div className="tmp-progress">
                                    <span className="tmp-steps" aria-hidden>
                                      {STAGES.map((st, k) => <span key={st} className={k <= stage ? "done" : ""} />)}
                                    </span>
                                    <span className="tmp-labels">
                                      {STAGES.map((st, k) => <span key={st} className={k === stage ? "cur" : ""}>{st}</span>)}
                                    </span>
                                  </div>
                                  <button type="button" className="btn btn-sm" onClick={() => onOpenTask(t)}>Open task</button>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
