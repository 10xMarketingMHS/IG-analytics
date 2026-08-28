import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useContentFormats } from "@/lib/use-content-formats";
import type { ContentFormatDef, TaskTimeRule } from "@/lib/types";

// A curated set — enough variety for common content work without turning the
// picker into an unscrollable wall of emoji. "Other" formats can still pick
// whichever reads best; nothing forces a literal meaning.
const ICON_OPTIONS = [
  "🎬", "🖼️", "📷", "🎥", "▶️", "🎙️", "📝", "🎨",
  "📱", "🖥️", "📊", "🗓️", "💡", "✂️", "🔊", "🔧",
];

// Rendered as one tab inside the master Settings page (see settings.tsx) —
// no outer <section className="screen"> here, that's Settings' job.
export function TaskRulesSection() {
  const { isAdmin } = useWorkspaces();
  const { editors } = useEditors();
  const { contentFormats, refetch: refetchFormats } = useContentFormats();
  const [rules, setRules] = useState<TaskTimeRule[] | null>(null);

  const load = useCallback(() => {
    api<{ rules: TaskTimeRule[] }>("/task-time-rules")
      .then(({ rules }) => setRules(rules))
      .catch(() => setRules([]));
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <>
        <div className="sectitle"><span className="dot" />Task Settings<span className="s">content formats & how much time each task gets</span></div>
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          Only admins can manage content formats and set how much time a task gets. When you create or work
          on a task, its format list and countdown (if any) follow whatever your admin has configured here.
        </div>
      </>
    );
  }

  async function setRule(contentFormatId: string, editorId: string | null, hours: number) {
    try {
      await api("/task-time-rules", { method: "POST", body: JSON.stringify({ contentFormatId, editorId, hours }) });
      toast.success(editorId ? "Override saved." : "Global default saved.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save rule.");
    }
  }
  async function removeRule(id: string) {
    try {
      await api(`/task-time-rules/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not clear override.");
    }
  }

  async function patchFormat(id: string, patch: Record<string, unknown>, errorMsg: string) {
    try {
      await api(`/content-formats/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refetchFormats();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : errorMsg);
    }
  }
  async function addFormat(name: string, icon: string, category: "social" | "ad") {
    try {
      await api("/content-formats", { method: "POST", body: JSON.stringify({ name, icon, category }) });
      await refetchFormats();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add that format.");
      throw err; // keep the add-row open so nothing typed gets lost
    }
  }
  async function removeFormat(f: ContentFormatDef) {
    if (!window.confirm(`Remove "${f.name}"? Tasks and rules already using it keep working — it just won't be offered for new ones.`)) return;
    try {
      await api(`/content-formats/${f.id}`, { method: "DELETE" });
      await refetchFormats();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that format.");
    }
  }

  const globalFor = (f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && !r.editor_id) ?? null;
  const overrideFor = (editorId: string, f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && r.editor_id === editorId) ?? null;
  const formats = contentFormats ?? [];

  // One Social section and one Ads section — each is a self-contained content
  // formats table + per-person overrides grid, scoped to that category's list.
  const CATEGORIES: { key: "social" | "ad"; label: string }[] = [
    { key: "social", label: "Social" },
    { key: "ad", label: "Ads" },
  ];

  return (
    <>
      {CATEGORIES.map(({ key, label }, i) => {
        const catFormats = formats.filter((f) => f.category === key);
        return (
          <div key={key}>
            <div className="sectitle" style={i > 0 ? { marginTop: 36 } : undefined}>
              <span className="dot" />{label} — content formats
              <span className="s">icon, points, and time budget together — click a name to rename it</span>
            </div>
            <div className="card pad">
              {contentFormats === null ? (
                <div className="hint">Loading…</div>
              ) : (
                <div className="fmt-table-wrap">
                  <table className="tbl fmt-tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 44 }}></th>
                        <th>Format</th>
                        <th style={{ width: 110, textAlign: "center" }}>Points</th>
                        <th style={{ width: 130, textAlign: "center" }}>Time budget</th>
                        <th style={{ width: 36 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {catFormats.map((f) => (
                        <FormatRow
                          key={f.id}
                          format={f}
                          rule={globalFor(f)}
                          onIcon={(icon) => patchFormat(f.id, { icon }, "Could not change the icon.")}
                          onRename={(name) => patchFormat(f.id, { name }, "Could not rename that format.")}
                          onPoints={(points) => patchFormat(f.id, { points }, "Could not save points.")}
                          onHours={(hours) => setRule(f.id, null, hours)}
                          onClearHours={() => { const r = globalFor(f); if (r) removeRule(r.id); }}
                          onRemove={() => removeFormat(f)}
                        />
                      ))}
                      <AddFormatRow onAdd={(name, icon) => addFormat(name, icon, key)} />
                    </tbody>
                  </table>
                </div>
              )}
              <div className="hint" style={{ marginTop: 14 }}>
                <b>Points</b> — the Points Formula's base value for this format (on/before due date earns it in full, 1 day
                late earns half, 2 days late earns none, 3+ days late costs it back). <b>Time budget</b> — hours before a
                task's countdown runs out; blank means no timer. The two are independent — a Reel and a Poster can score
                differently even at the same time budget. Removing a format doesn't touch tasks already using it.
              </div>
            </div>

            <div className="sectitle" style={{ marginTop: 28 }}>
              <span className="dot" />{label} — per-person overrides
              <span className="s">every team member, editable inline — blank cells inherit the global default</span>
            </div>
            <div className="card pad">
              {rules === null || !editors || contentFormats === null ? (
                <div className="hint">Loading…</div>
              ) : editors.length === 0 ? (
                <div className="hint">No team members yet — add editors under Settings first.</div>
              ) : catFormats.length === 0 ? (
                <div className="hint">No {label} content formats yet — add one above first.</div>
              ) : (
                <div className="bulk-scroll fmt-overrides-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Team member</th>
                        {catFormats.map((f) => (
                          <th key={f.id} style={{ textAlign: "center" }}>{f.icon} {f.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {editors.map((ed) => (
                        <tr key={ed.id}>
                          <td style={{ fontWeight: 650 }}>{ed.name}</td>
                          {catFormats.map((f) => (
                            <td key={f.id} style={{ textAlign: "center" }}>
                              <OverrideCell
                                rule={overrideFor(ed.id, f)}
                                globalHours={globalFor(f)?.hours ?? null}
                                onSave={(hours) => setRule(f.id, ed.id, hours)}
                                onClear={(id) => removeRule(id)}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="hint" style={{ marginTop: 12 }}>
                Type a number and click away to save — that person always gets exactly that much time for that format, ignoring
                the global default above. Clear the cell (and click away) to remove the override and fall back to the default.
              </div>
            </div>
          </div>
        );
      })}
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
    <div className="iconpicker" ref={ref}>
      <button type="button" className="iconpicker-trigger" onClick={() => setOpen((o) => !o)} title="Change icon">
        {value}
      </button>
      {open && (
        <div className="iconpicker-pop">
          {ICON_OPTIONS.map((ic) => (
            <button
              key={ic}
              type="button"
              className={"iconpicker-opt" + (ic === value ? " on" : "")}
              onClick={() => { onPick(ic); setOpen(false); }}
            >
              {ic}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// One format's full row: icon, name (click to rename), points, time budget,
// remove. Each field saves independently on blur/pick, same "no Save button"
// pattern as the rest of this page.
function FormatRow({
  format, rule, onIcon, onRename, onPoints, onHours, onClearHours, onRemove,
}: {
  format: ContentFormatDef;
  rule: TaskTimeRule | null;
  onIcon: (icon: string) => void;
  onRename: (name: string) => void;
  onPoints: (points: number) => void;
  onHours: (hours: number) => void;
  onClearHours: () => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(format.name);
  const [points, setPoints] = useState(format.points.toString());
  const [hours, setHours] = useState(rule?.hours?.toString() ?? "");

  useEffect(() => setName(format.name), [format.name]);
  useEffect(() => setPoints(format.points.toString()), [format.points]);
  useEffect(() => setHours(rule?.hours?.toString() ?? ""), [rule?.hours]);

  function saveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === format.name) { setName(format.name); return; }
    onRename(trimmed);
  }
  function savePoints() {
    const n = Number(points);
    if (points === "" || !(n >= 0)) { setPoints(format.points.toString()); return; }
    if (n === format.points) return;
    onPoints(n);
  }
  function saveHours() {
    const trimmed = hours.trim();
    if (!trimmed) { if (rule) onClearHours(); return; }
    const n = Number(trimmed);
    if (!(n > 0)) { setHours(rule?.hours?.toString() ?? ""); return; }
    if (rule && n === rule.hours) return;
    onHours(n);
  }
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  return (
    <tr>
      <td><IconPicker value={format.icon} onPick={onIcon} /></td>
      <td>
        <input
          className="t fmt-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <input
          className="t" type="number" min="0" step="0.5" style={{ width: 86, textAlign: "center" }}
          value={points} onChange={(e) => setPoints(e.target.value)} onBlur={savePoints} onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <input
          className="t" type="number" min="0.5" step="0.5" placeholder="—" style={{ width: 86, textAlign: "center" }}
          value={hours} onChange={(e) => setHours(e.target.value)} onBlur={saveHours} onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <button type="button" className="linkbtn" style={{ color: "var(--rose)" }} onClick={onRemove} title="Remove format">✕</button>
      </td>
    </tr>
  );
}

// Bottom row of the table — collapses to a plain "+ Add format" link, expands
// into name + icon fields inline (no modal) when clicked.
function AddFormatRow({ onAdd }: { onAdd: (name: string, icon: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🔧");
  const [saving, setSaving] = useState(false);

  if (!adding) {
    return (
      <tr>
        <td colSpan={5} style={{ padding: "10px 8px" }}>
          <button type="button" className="linkbtn" onClick={() => setAdding(true)}>＋ Add format</button>
        </td>
      </tr>
    );
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await onAdd(trimmed, icon);
      setName("");
      setIcon("🔧");
      setAdding(false);
    } catch {
      // onAdd already toasted the error — leave the row open so nothing's lost.
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td><IconPicker value={icon} onPick={setIcon} /></td>
      <td>
        <input
          className="t fmt-name-input"
          autoFocus
          placeholder="New format name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            if (e.key === "Escape") setAdding(false);
          }}
        />
      </td>
      <td colSpan={3} style={{ display: "flex", gap: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving || !name.trim()} onClick={submit}>
          {saving ? "…" : "Add"}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>Cancel</button>
      </td>
    </tr>
  );
}

// One matrix cell — blank shows the global default as a placeholder (so it's
// clear what the person is currently getting even with no override set).
function OverrideCell({
  rule, globalHours, onSave, onClear,
}: {
  rule: TaskTimeRule | null;
  globalHours: number | null;
  onSave: (hours: number) => void;
  onClear: (ruleId: string) => void;
}) {
  const [value, setValue] = useState(rule?.hours?.toString() ?? "");

  useEffect(() => { setValue(rule?.hours?.toString() ?? ""); }, [rule?.hours]);

  function commit() {
    const trimmed = value.trim();
    if (!trimmed) {
      if (rule) onClear(rule.id);
      return;
    }
    const n = Number(trimmed);
    if (!(n > 0)) { setValue(rule?.hours?.toString() ?? ""); return; }
    if (rule && n === rule.hours) return;
    onSave(n);
  }

  return (
    <input
      className="t"
      type="number"
      min="0.5"
      step="0.5"
      style={{ width: 80, textAlign: "center", padding: "8px 6px" }}
      placeholder={globalHours != null ? String(globalHours) : "—"}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
