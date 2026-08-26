import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useContentFormats } from "@/lib/use-content-formats";
import type { ContentFormatDef, TaskTimeRule } from "@/lib/types";

// Rendered as one tab inside the master Settings page (see settings.tsx) —
// no outer <section className="screen"> here, that's Settings' job.
export function TaskRulesSection() {
  const { isAdmin } = useWorkspaces();
  const { editors } = useEditors();
  const { contentFormats } = useContentFormats();
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

  const globalFor = (f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && !r.editor_id) ?? null;
  const overrideFor = (editorId: string, f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && r.editor_id === editorId) ?? null;
  const formats = contentFormats ?? [];

  return (
    <>
      <div className="sectitle">
        <span className="dot" />Content formats
        <span className="s">what production formats your org uses — click one to rename it</span>
      </div>
      <FormatManager />

      <div className="sectitle" style={{ marginTop: 28 }}>
        <span className="dot" />Global defaults
        <span className="s">how long each content format should take, org-wide</span>
      </div>
      <div className="card pad">
        {rules === null || contentFormats === null ? (
          <div className="hint">Loading…</div>
        ) : formats.length === 0 ? (
          <div className="hint">No content formats yet — add one from the Add Task modal, or under Settings.</div>
        ) : (
          <div className="grid g4">
            {formats.map((f) => (
              <FormatBox key={f.id} format={f} rule={globalFor(f)} onSave={(hours) => setRule(f.id, null, hours)} onRemove={globalFor(f) ? () => removeRule(globalFor(f)!.id) : undefined} />
            ))}
          </div>
        )}
        <div className="hint" style={{ marginTop: 14 }}>
          When someone creates a task in a format with no rule set here (and no personal override), that task simply has no timer.
        </div>
      </div>

      <div className="sectitle" style={{ marginTop: 28 }}>
        <span className="dot" />Per-person overrides
        <span className="s">every team member, editable inline — blank cells inherit the global default</span>
      </div>
      <div className="card pad">
        {rules === null || !editors || contentFormats === null ? (
          <div className="hint">Loading…</div>
        ) : editors.length === 0 ? (
          <div className="hint">No team members yet — add editors under Settings first.</div>
        ) : formats.length === 0 ? (
          <div className="hint">No content formats yet.</div>
        ) : (
          <div className="bulk-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Team member</th>
                  {formats.map((f) => (
                    <th key={f.id} style={{ textAlign: "center" }}>{f.icon} {f.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {editors.map((ed) => (
                  <tr key={ed.id}>
                    <td style={{ fontWeight: 650 }}>{ed.name}</td>
                    {formats.map((f) => (
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
    </>
  );
}

// Add, rename, or retire the org's content formats (Video/Reels/Image/…) —
// the same admin-manageable taxonomy the Add Task modal lets you grow inline,
// just with rename/remove alongside add.
function FormatManager() {
  const { contentFormats, refetch } = useContentFormats();
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [savingNew, setSavingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function addFormat() {
    const name = newName.trim();
    if (!name) return;
    setSavingNew(true);
    try {
      await api("/content-formats", { method: "POST", body: JSON.stringify({ name }) });
      await refetch();
      setNewName("");
      setAddingNew(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add that format.");
    } finally {
      setSavingNew(false);
    }
  }

  async function renameFormat(id: string, currentName: string) {
    const name = editName.trim();
    setEditingId(null);
    if (!name || name === currentName) return;
    try {
      await api(`/content-formats/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename that format.");
    }
  }

  async function removeFormat(f: ContentFormatDef) {
    if (!window.confirm(`Remove "${f.name}"? Tasks and rules already using it keep working — it just won't be offered for new ones.`)) return;
    try {
      await api(`/content-formats/${f.id}`, { method: "DELETE" });
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that format.");
    }
  }

  return (
    <div className="card pad">
      {contentFormats === null ? (
        <div className="hint">Loading…</div>
      ) : (
        <div className="formatpills">
          {contentFormats.map((f) =>
            editingId === f.id ? (
              <span className="formatpill-add" key={f.id}>
                <input
                  className="t"
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); renameFormat(f.id, f.name); }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => renameFormat(f.id, f.name)}
                />
              </span>
            ) : (
              <span className="formatpill on formatpill-manage" key={f.id}>
                <button type="button" className="formatpill-label" onClick={() => { setEditingId(f.id); setEditName(f.name); }} title="Click to rename">
                  {f.icon} {f.name}
                </button>
                <button type="button" className="formatpill-x" onClick={() => removeFormat(f)} title="Remove">✕</button>
              </span>
            ),
          )}
          {addingNew ? (
            <span className="formatpill-add">
              <input
                className="t"
                autoFocus
                placeholder="New format name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFormat(); } if (e.key === "Escape") setAddingNew(false); }}
              />
              <button type="button" className="btn btn-sm btn-primary" disabled={savingNew || !newName.trim()} onClick={addFormat}>
                {savingNew ? "…" : "Add"}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setAddingNew(false); setNewName(""); }}>✕</button>
            </span>
          ) : (
            <button type="button" className="formatpill formatpill-new" onClick={() => setAddingNew(true)}>
              ＋ New format
            </button>
          )}
        </div>
      )}
      <div className="hint" style={{ marginTop: 12 }}>
        Click a format to rename it. Removing one doesn't touch tasks that already use it — it just stops being offered for new ones.
      </div>
    </div>
  );
}

function FormatBox({
  format, rule, onSave, onRemove,
}: {
  format: ContentFormatDef;
  rule: TaskTimeRule | null;
  onSave: (hours: number) => void;
  onRemove?: () => void;
}) {
  const [hours, setHours] = useState(rule?.hours?.toString() ?? "");

  useEffect(() => { setHours(rule?.hours?.toString() ?? ""); }, [rule?.hours]);

  function save() {
    const n = Number(hours);
    if (!hours || !(n > 0)) return;
    onSave(n);
  }

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label className="f">{format.icon} {format.name}</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="t"
          type="number"
          min="0.5"
          step="0.5"
          placeholder="Hours"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
        />
        {onRemove && (
          <button type="button" className="linkbtn" style={{ color: "var(--rose)" }} onClick={onRemove} title="Clear default">✕</button>
        )}
      </div>
    </div>
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
