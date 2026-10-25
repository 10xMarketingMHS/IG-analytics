import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useContentFormats } from "@/lib/use-content-formats";
import { useIsSuper } from "@/lib/use-org";
import type { ContentFormatDef, TaskTimeRule } from "@/lib/types";
import { SI, Stepper, Toggle, fmtHours } from "@/pages/settings-ui";

// Settings › Tasks & time (Pulse Redesign v5): every task type in one list,
// grouped Social / Ads / Service / Project — its icon, name, category, whether
// it needs a delivery link for review, whether approved Social work of it goes
// to Scheduling, its Key/Critical metric tag, points and
// time budget (a project type has a duration in days instead). Each change
// saves on its own a moment after the last click. Below: breaks and the task
// rules everyone works by. Admins or the task_settings grant.

// A curated set — enough variety for common content work without turning the
// picker into an unscrollable wall of emoji.
const ICON_OPTIONS = [
  "🎬", "🖼️", "📷", "🎥", "▶️", "🎙️", "📝", "🎨",
  "📱", "🖥️", "📊", "🗓️", "💡", "✂️", "🔊", "🔧",
];

type Cat = "social" | "ad" | "service" | "project";
const CATS: { key: Cat; label: string; icon: ReactNode }[] = [
  { key: "social", label: "Social", icon: SI.megaphone },
  { key: "ad", label: "Ads", icon: SI.card },
  { key: "service", label: "Service", icon: SI.headset },
  { key: "project", label: "Project", icon: SI.folder },
];
// Matches the server's daily break cap (routes/breaks.js).
const BREAK_MINUTES = 75;
const trim = (n: number) => String(Math.round(n * 100) / 100);

// Saves `value` a moment after it last changed, unless it already matches what's
// saved — so three quick clicks on + make one request, not three.
function useAutoSave<T>(value: T, saved: T, save: (v: T) => void, delay = 700) {
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (value === saved) return;
    const t = setTimeout(() => saveRef.current(value), delay);
    return () => clearTimeout(t);
  }, [value, saved, delay]);
}

export function TaskRulesSection() {
  const { hasPermission } = useWorkspaces();
  const canManage = hasPermission("task_settings");
  // what a type is worth is the Super Admin's call; admins see the points
  const canPoints = useIsSuper();
  const { contentFormats, refetch: refetchFormats } = useContentFormats();
  const [rules, setRules] = useState<TaskTimeRule[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState<Cat>("social");
  const [newIcon, setNewIcon] = useState("🔧");
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<{ rules: TaskTimeRule[] }>("/task-time-rules")
      .then(({ rules }) => setRules(rules))
      .catch(() => setRules([]));
  }, []);
  useEffect(() => { if (canManage) load(); }, [canManage, load]);

  if (!canManage) {
    return (
      <section className="st-card">
        <div className="st-empty">
          Only admins can manage task types and how much time a task gets. When you create or work on a task, its type list and
          countdown follow whatever your admin set here.
        </div>
      </section>
    );
  }

  async function setRule(contentFormatId: string, editorId: string | null, hours: number) {
    try {
      await api("/task-time-rules", { method: "POST", body: JSON.stringify({ contentFormatId, editorId, hours }) });
      toast.success(editorId ? "Their time saved." : "Time budget saved.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the time.");
    }
  }
  async function removeRule(id: string, quiet = false) {
    try {
      await api(`/task-time-rules/${id}`, { method: "DELETE" });
      if (!quiet) toast.success("Timer removed.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not clear that time.");
    }
  }
  async function patchFormat(id: string, patch: Record<string, unknown>, errorMsg: string, okMsg?: string | ((r: { schedulingMoved?: number }) => string)) {
    try {
      const r = await api<{ schedulingMoved?: number }>(`/content-formats/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refetchFormats();
      if (okMsg) toast.success(typeof okMsg === "function" ? okMsg(r) : okMsg);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : errorMsg);
    }
  }
  async function addFormat() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await api("/content-formats", { method: "POST", body: JSON.stringify({ name, icon: newIcon, category: newCat }) });
      await refetchFormats();
      toast.success(`${name} added · now on New task and Goals.`);
      setNewName("");
      setNewIcon("🔧");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add that task type.");
    } finally {
      setAdding(false);
    }
  }
  async function moveFormat(f: ContentFormatDef, category: Cat) {
    const to = CATS.find((c) => c.key === category)?.label ?? category;
    const from = CATS.find((c) => c.key === f.category)?.label ?? f.category;
    if (!window.confirm(`Move "${f.name}" from ${from} to ${to}? New tasks of this type are made as ${to}; tasks already made stay ${from}.`)) return;
    await patchFormat(f.id, { category }, "Could not change the category.", `${f.name} moved to ${to}.`);
  }
  async function removeFormat(f: ContentFormatDef) {
    if (!window.confirm(`Remove "${f.name}"? Tasks and rules already using it keep working — it just won't be offered for new ones.`)) return;
    try {
      await api(`/content-formats/${f.id}`, { method: "DELETE" });
      await refetchFormats();
      toast.success(`${f.name} removed.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that task type.");
    }
  }

  const formats = contentFormats ?? [];
  const globalFor = (f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && !r.editor_id) ?? null;

  return (
    <>
      <section className="st-card">
        <div className="st-cardhead">
          <span className="st-titleline"><b>Task types</b><span className="st-count">{formats.length}</span></span>
          <span>One list for the whole workspace. Points are what a finished job earns; time budget is how long the timer gives it. A change to points counts from now on: jobs already completed, and goals already set, keep the points they had.{canPoints ? "" : " Only a Super Admin can change points."}</span>
          <span className="st-uses">
            <span>{SI.addTask}New task picker</span>
            <span>{SI.flag}Goal types</span>
            <span>{SI.groups}Team · Today</span>
            <span>{SI.stopwatch}Timer budget</span>
          </span>
        </div>
        <div className="st-tt-head" aria-hidden="true">
          <span>Type</span>
          <span className="st-c-link">Link</span>
          <span className="st-c-sched">Next step</span>
          <span className="st-c-metric">Metric</span>
          <span className="st-c-pts">Points</span>
          <span className="st-c-time">Time</span>
          <span className="st-c-del" />
        </div>
        {contentFormats === null || rules === null ? (
          <div className="st-empty">Loading…</div>
        ) : formats.length === 0 ? (
          <div className="st-empty">No task types yet — add the first one below.</div>
        ) : CATS.map((c) => {
          const rows = formats.filter((f) => f.category === c.key);
          if (!rows.length) return null;
          return (
            <Fragment key={c.key}>
              <div className="st-ttgroup">{c.icon}{c.label}<span className="st-count">{rows.length}</span></div>
              {rows.map((f) => (
                <TypeRow
                  key={f.id}
                  format={f}
                  rule={globalFor(f)}
                  canPoints={canPoints}
                  onCategory={(category) => moveFormat(f, category)}
                  onIcon={(icon) => patchFormat(f.id, { icon }, "Could not change the icon.")}
                  onRename={(name) => patchFormat(f.id, { name }, "Could not rename that type.", "Renamed.")}
                  onPoints={(points) => patchFormat(f.id, { points }, "Could not save points.", `${f.name}: ${trim(points)} point${points === 1 ? "" : "s"}.`)}
                  onMetric={(metric_tier) => patchFormat(f.id, { metric_tier }, "Could not update the metric tag.", "Metric tag saved.")}
                  onLink={(review_link_required) => patchFormat(f.id, { review_link_required }, "Could not update the review link setting.",
                    review_link_required ? "A link is now needed for review." : "No link needed for review now.")}
                  onSched={(to_scheduling) => patchFormat(f.id, { to_scheduling }, "Could not update the next step.", ({ schedulingMoved: n = 0 }) => {
                    const tasks = `${n} approved task${n === 1 ? "" : "s"}`;
                    const list = f.category === "ad" ? "Ad uploads" : "Scheduling";
                    return to_scheduling
                      ? `Approved ${f.name} work now goes to ${list}.${n ? ` ${tasks} from this month added to the list.` : ""}`
                      : `${f.name} no longer goes to ${list}.${n ? ` ${tasks} still waiting left the list.` : ""}`;
                  })}
                  onHours={(hours) => setRule(f.id, null, hours)}
                  onClearHours={() => { const r = globalFor(f); if (r) removeRule(r.id); }}
                  onDuration={(duration_days) => patchFormat(f.id, { duration_days }, "Could not save the duration.", "Duration saved.")}
                  onMetrics={(metrics_description) => patchFormat(f.id, { metrics_description }, "Could not save that note.")}
                  onRemove={() => removeFormat(f)}
                />
              ))}
            </Fragment>
          );
        })}
        <div className="st-foot">
          <IconPicker value={newIcon} onPick={setNewIcon} />
          <input className="st-in grow" placeholder="New task type" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !adding) addFormat(); }} />
          <select className="st-in" value={newCat} onChange={(e) => setNewCat(e.target.value as Cat)} aria-label="Kind of work" style={{ width: 130 }}>
            {CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button type="button" className="st-btn pri" disabled={adding || !newName.trim()} onClick={addFormat}>{SI.plus}{adding ? "Adding…" : "Add"}</button>
        </div>
      </section>
      <span className="st-note">
        Link — a task of this type can't go to review without a delivery link (untick it for scheduling, data or technical work). Next step — an approved
        Social task of this type goes to Scheduling, for its post date and links (untick it for thumbnails and other work that isn't posted on its own); an approved
        Ads task goes to Ad uploads, for the ad numbers it became. Points — on or
        before the due date earns them in full, 1 day late half, 2 days none, 3 or more costs them back. Removing a type doesn't touch tasks already using it.
      </span>

      <section className="st-card">
        <div className="st-cardhead"><b>Breaks</b></div>
        <div className="st-row">
          <span className="st-label">
            <b>Daily break allowance</b>
            <small>Lunch 45m and two tea breaks of 15m, the same for everyone · shown in the sidebar</small>
          </span>
          <span className="st-value st-mono">{fmtHours(BREAK_MINUTES / 60)} / day</span>
        </div>
        <RuleRow l="Pause the running timer during a break" d="Break time is added back to the task's time budget" />
      </section>

      <section className="st-card">
        <div className="st-cardhead">
          <b>Task rules</b>
          <span>How tasks work for everyone. These are always on for now.</span>
        </div>
        <RuleRow l="Create a task when an editor is assigned to a post" d="Title, channel and due date carry over and stay in sync" />
        <RuleRow l="Assignee accepts before work starts" d="A task someone else gives you waits as “Pending accept” until you take it" />
        <RuleRow l="Finished work goes to review first" d="An admin approves it before it counts as completed" />
        <RuleRow l="Flag tasks that pass their time budget" d="The timer turns red once a task runs past its time" />
      </section>
    </>
  );
}

// One always-on rule: shown switched on, and locked.
function RuleRow({ l, d }: { l: string; d: string }) {
  return (
    <div className="st-row">
      <span className="st-label"><b>{l}</b><small>{d}</small></span>
      <span className="st-always">Always on</span>
      <Toggle on onChange={() => {}} disabled label={`${l} — always on`} />
    </div>
  );
}

// A small icon-swatch popover — click the current icon to pick a new one.
// Closes on an outside click or after picking. The settings card hides what
// spills past its edge, so near the bottom (New task type, the last type)
// it opens upward instead.
function IconPicker({ value, onPick }: { value: string; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) { setUp(false); return; }
    const pop = popRef.current?.getBoundingClientRect();
    const card = ref.current?.closest(".st-card")?.getBoundingClientRect();
    if (pop && card && pop.bottom > card.bottom - 4) setUp(true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  return (
    <div className="st-ic" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} title="Change icon" aria-label="Change icon" aria-expanded={open}>{value}</button>
      {open && (
        <div ref={popRef} className={"st-icpop" + (up ? " up" : "")} role="listbox" aria-label="Icons">
          {ICON_OPTIONS.map((ic) => (
            <button key={ic} type="button" role="option" aria-selected={ic === value} className={ic === value ? "on" : ""} onClick={() => { onPick(ic); setOpen(false); }}>{ic}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// One task type: icon, name (click to rename), link toggle, scheduling toggle
// (Social types), metric tag, points and time (or duration). Every field saves on its own.
function TypeRow({
  format, rule, canPoints, onCategory, onIcon, onRename, onPoints, onMetric, onLink, onSched, onHours, onClearHours, onDuration, onMetrics, onRemove,
}: {
  format: ContentFormatDef;
  rule: TaskTimeRule | null;
  canPoints: boolean;
  onCategory: (category: Cat) => void;
  onIcon: (icon: string) => void;
  onRename: (name: string) => void;
  onPoints: (points: number) => void;
  onMetric: (tier: "key" | "critical" | null) => void;
  onLink: (required: boolean) => void;
  onSched: (on: boolean) => void;
  onHours: (hours: number) => void;
  onClearHours: () => void;
  onDuration: (days: number | null) => void;
  onMetrics: (text: string | null) => void;
  onRemove: () => void;
}) {
  const isProject = format.category === "project";
  const [name, setName] = useState(format.name);
  const [metrics, setMetrics] = useState(format.metrics_description ?? "");
  const [points, setPoints] = useState(Number(format.points));
  const savedHours = rule?.hours != null ? Number(rule.hours) : null;
  const [hours, setHours] = useState<number | null>(savedHours);
  const [days, setDays] = useState<number | null>(format.duration_days ?? null);

  useEffect(() => setName(format.name), [format.name]);
  useEffect(() => setMetrics(format.metrics_description ?? ""), [format.metrics_description]);
  useEffect(() => setPoints(Number(format.points)), [format.points]);
  useEffect(() => setHours(savedHours), [savedHours]);
  useEffect(() => setDays(format.duration_days ?? null), [format.duration_days]);

  useAutoSave(points, Number(format.points), onPoints);
  useAutoSave(hours, savedHours, (h) => (h == null ? onClearHours() : onHours(h)));
  useAutoSave(days, format.duration_days ?? null, onDuration);

  function saveName() {
    const t = name.trim();
    if (!t || t === format.name) { setName(format.name); return; }
    onRename(t);
  }
  function saveMetrics() {
    const next = metrics.trim() || null;
    if (next !== (format.metrics_description ?? null)) onMetrics(next);
  }
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };

  return (
    <div className="st-tt">
      <span className="st-tt-name">
        <IconPicker value={format.icon} onPick={onIcon} />
        <span>
          <input className="st-plain" value={name} aria-label="Name" onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={blurOnEnter} />
          <span className="st-tt-sub">
            <select className="st-kind" value={format.category ?? "social"} aria-label={`${format.name} category`} title="Change the category"
              onChange={(e) => onCategory(e.target.value as Cat)}>
              {CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            {isProject && (
              <input className="st-metrics" value={metrics} placeholder="What this project delivers (a note, not scored)…" aria-label={`What ${format.name} delivers`}
                onChange={(e) => setMetrics(e.target.value)} onBlur={saveMetrics} onKeyDown={blurOnEnter} />
            )}
          </span>
        </span>
      </span>
      <span className="st-c-link">
        <span className="st-mlabel">Link</span>
        <Toggle on={format.review_link_required} onChange={onLink} label={`${format.name} needs a delivery link for review`} />
      </span>
      <span className="st-c-sched">
        {(format.category === "social" || format.category === "ad") && format.to_scheduling !== undefined ? (
          <><span className="st-mlabel">{format.category === "ad" ? "Ad uploads" : "Scheduling"}</span>
            <Toggle on={format.to_scheduling} onChange={onSched}
              label={`Approved ${format.name} work goes to ${format.category === "ad" ? "Ad uploads" : "Scheduling"}`} /></>
        ) : <span className="st-note" style={{ justifyContent: "center" }}
          title={format.category === "social" || format.category === "ad" ? "Needs the scheduling database update" : "Only Social and Ads work goes on after approval"}>—</span>}
      </span>
      <span className="st-c-metric">
        {!isProject && <span className="st-mlabel">Metric</span>}
        {isProject ? <span className="st-note" style={{ justifyContent: "center" }}>—</span> : (
          <select className="st-in" value={format.metric_tier ?? ""} onChange={(e) => onMetric((e.target.value || null) as "key" | "critical" | null)}
            aria-label={`${format.name} metric tag`} title="Tag it as a Key or Critical metric for Management Performance">
            <option value="">None</option>
            <option value="key">Key</option>
            <option value="critical">Critical</option>
          </select>
        )}
      </span>
      <span className="st-c-pts">
        <span className="st-mlabel">Points</span>
        <Stepper className="sm acc pts" label={`points for ${format.name}`} value={trim(points)}
          onDec={() => setPoints((p) => Math.max(0, Math.round((p - 1) * 100) / 100))} onInc={() => setPoints((p) => Math.min(1000, Math.round((p + 1) * 100) / 100))}
          decDisabled={!canPoints || points <= 0} incDisabled={!canPoints} />
      </span>
      <span className="st-c-time">
        <span className="st-mlabel">{isProject ? "Days" : "Time"}</span>
        {isProject ? (
          <Stepper className={"sm time" + (days == null ? " none" : "")} label={`days for ${format.name}`} value={days == null ? "No limit" : `${days} day${days === 1 ? "" : "s"}`}
            onDec={() => setDays((d) => (d == null || d <= 1 ? null : d - 1))} onInc={() => setDays((d) => Math.min(3650, (d ?? 0) + 1))} decDisabled={days == null} />
        ) : (
          <Stepper className={"sm time" + (hours == null ? " none" : "")} label={`time for ${format.name}`} value={hours == null ? "No timer" : fmtHours(hours)}
            onDec={() => setHours((h) => (h == null || h <= 0.25 ? null : h - 0.25))} onInc={() => setHours((h) => Math.min(999, h == null ? 0.5 : h + 0.25))} decDisabled={hours == null} />
        )}
      </span>
      <span className="st-c-del">
        <button type="button" className="st-icobtn" onClick={onRemove} title="Remove" aria-label={`Remove ${format.name}`}>{SI.trash}</button>
      </span>
    </div>
  );
}
