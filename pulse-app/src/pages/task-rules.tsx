import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useContentFormats } from "@/lib/use-content-formats";
import type { ContentFormatDef, TaskTimeRule } from "@/lib/types";
import { SI, Seg, Stepper, Toggle, fmtHours } from "@/pages/settings-ui";

// Settings › Tasks & time (Pulse Redesign v5): every task type in one list,
// grouped Social / Ads / Service / Project — its icon, name, whether it needs a
// delivery link for review, its Key/Critical metric tag, points and time budget
// (a project type has a duration in days instead). Each change saves on its own
// a moment after the last click. Below: time per person, and the break
// allowance. Admins or the task_settings grant.

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
  const { editors } = useEditors();
  const { contentFormats, refetch: refetchFormats } = useContentFormats();
  const [rules, setRules] = useState<TaskTimeRule[] | null>(null);
  const [perCat, setPerCat] = useState<Cat>("social");
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
  async function patchFormat(id: string, patch: Record<string, unknown>, errorMsg: string, okMsg?: string) {
    try {
      await api(`/content-formats/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refetchFormats();
      if (okMsg) toast.success(okMsg);
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
  const overrideFor = (editorId: string, f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && r.editor_id === editorId) ?? null;
  const ownCount = (f: ContentFormatDef) => (rules ?? []).filter((r) => r.content_format_id === f.id && r.editor_id).length;
  const perFormats = formats.filter((f) => f.category === perCat);
  const catsWithTypes = CATS.filter((c) => formats.some((f) => f.category === c.key));

  return (
    <>
      <section className="st-card">
        <div className="st-cardhead">
          <span className="st-titleline"><b>Task types</b><span className="st-count">{formats.length}</span></span>
          <span>One list for the whole workspace. Points are what a finished job earns; time budget is how long the timer gives it.</span>
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
                  own={ownCount(f)}
                  onIcon={(icon) => patchFormat(f.id, { icon }, "Could not change the icon.")}
                  onRename={(name) => patchFormat(f.id, { name }, "Could not rename that type.", "Renamed.")}
                  onPoints={(points) => patchFormat(f.id, { points }, "Could not save points.", `${f.name}: ${trim(points)} point${points === 1 ? "" : "s"}.`)}
                  onMetric={(metric_tier) => patchFormat(f.id, { metric_tier }, "Could not update the metric tag.", "Metric tag saved.")}
                  onLink={(review_link_required) => patchFormat(f.id, { review_link_required }, "Could not update the review link setting.",
                    review_link_required ? "A link is now needed for review." : "No link needed for review now.")}
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
        Link — a task of this type can't go to review without a delivery link (untick it for scheduling, data or technical work). Points — on or
        before the due date earns them in full, 1 day late half, 2 days none, 3 or more costs them back. Removing a type doesn't touch tasks already using it.
      </span>

      <section className="st-card">
        <div className="st-cardhead">
          <b>Time per person</b>
          <span>Someone faster or slower than the time budget above gets their own. Blank uses the budget. Type hours and click away to save; clear a cell to go back.</span>
        </div>
        {catsWithTypes.length > 1 && (
          <div className="st-row">
            <Seg label="Kind of work" value={perCat} options={catsWithTypes.map((c) => [c.key, c.label] as [Cat, string])} onChange={setPerCat} />
          </div>
        )}
        {rules === null || !editors || contentFormats === null ? (
          <div className="st-empty">Loading…</div>
        ) : editors.length === 0 ? (
          <div className="st-empty">No team members yet — add people on Team · Roster first.</div>
        ) : perFormats.length === 0 ? (
          <div className="st-empty">No {CATS.find((c) => c.key === perCat)?.label} task types yet.</div>
        ) : (
          <div className="st-ovwrap">
            <table className="st-ov">
              <thead>
                <tr>
                  <th>Team member</th>
                  {perFormats.map((f) => <th key={f.id}>{f.icon} {f.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {editors.map((ed) => (
                  <tr key={ed.id}>
                    <td>{ed.name}</td>
                    {perFormats.map((f) => (
                      <td key={f.id}>
                        <OverrideCell
                          label={`${ed.name}'s hours for ${f.name}`}
                          rule={overrideFor(ed.id, f)}
                          globalHours={globalFor(f)?.hours ?? null}
                          onSave={(hours) => setRule(f.id, ed.id, hours)}
                          onClear={(id) => removeRule(id, true)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="st-card">
        <div className="st-cardhead"><b>Breaks</b></div>
        <div className="st-row">
          <span className="st-label">
            <b>Daily break allowance</b>
            <small>Lunch and tea together, the same for everyone — shown in the sidebar</small>
          </span>
          <span className="st-value st-mono">{fmtHours(BREAK_MINUTES / 60)} / day</span>
        </div>
      </section>
    </>
  );
}

// A small icon-swatch popover — click the current icon to pick a new one.
// Closes on an outside click or after picking.
function IconPicker({ value, onPick }: { value: string; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
        <div className="st-icpop" role="listbox" aria-label="Icons">
          {ICON_OPTIONS.map((ic) => (
            <button key={ic} type="button" role="option" aria-selected={ic === value} className={ic === value ? "on" : ""} onClick={() => { onPick(ic); setOpen(false); }}>{ic}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// One task type: icon, name (click to rename), link toggle, metric tag, points
// and time (or duration). Every field saves on its own.
function TypeRow({
  format, rule, own, onIcon, onRename, onPoints, onMetric, onLink, onHours, onClearHours, onDuration, onMetrics, onRemove,
}: {
  format: ContentFormatDef;
  rule: TaskTimeRule | null;
  own: number;
  onIcon: (icon: string) => void;
  onRename: (name: string) => void;
  onPoints: (points: number) => void;
  onMetric: (tier: "key" | "critical" | null) => void;
  onLink: (required: boolean) => void;
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
          {isProject ? (
            <input className="st-metrics" value={metrics} placeholder="What this project delivers (a note, not scored)…" aria-label={`What ${format.name} delivers`}
              onChange={(e) => setMetrics(e.target.value)} onBlur={saveMetrics} onKeyDown={blurOnEnter} />
          ) : own > 0 ? (
            <small>{own} {own === 1 ? "person has" : "people have"} their own time</small>
          ) : null}
        </span>
      </span>
      <span className="st-c-link">
        <span className="st-mlabel">Link</span>
        <Toggle on={format.review_link_required} onChange={onLink} label={`${format.name} needs a delivery link for review`} />
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
          decDisabled={points <= 0} />
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

// One cell of the time-per-person table — blank shows the budget as a hint,
// so it's clear what the person gets even without their own time.
function OverrideCell({ label, rule, globalHours, onSave, onClear }: {
  label: string;
  rule: TaskTimeRule | null;
  globalHours: number | null;
  onSave: (hours: number) => void;
  onClear: (ruleId: string) => void;
}) {
  const [value, setValue] = useState(rule?.hours?.toString() ?? "");
  useEffect(() => { setValue(rule?.hours?.toString() ?? ""); }, [rule?.hours]);
  function commit() {
    const t = value.trim();
    if (!t) { if (rule) onClear(rule.id); return; }
    const n = Number(t);
    if (!(n > 0)) { setValue(rule?.hours?.toString() ?? ""); return; }
    if (rule && n === Number(rule.hours)) return;
    onSave(n);
  }
  return (
    <input
      type="number" min="0.25" step="0.25" aria-label={label}
      placeholder={globalHours != null ? trim(Number(globalHours)) : "—"}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
