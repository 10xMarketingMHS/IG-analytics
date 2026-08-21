import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import type { ContentFormat, TaskTimeRule } from "@/lib/types";

const FORMAT_LABEL: Record<ContentFormat, string> = { video: "Video", image: "Image", shoot: "Shoot", other: "Other" };
const FORMAT_ICON: Record<ContentFormat, string> = { video: "🎬", image: "🖼️", shoot: "📷", other: "🔧" };
const FORMATS: ContentFormat[] = ["video", "image", "shoot", "other"];

export function TaskRulesPage() {
  const { isAdmin } = useWorkspaces();
  const { editors } = useEditors();
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
      <section className="screen">
        <div className="sectitle"><span className="dot" />Time Rules<span className="s">how task budgets are set</span></div>
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          Only admins can set time budgets. When you create or work on a task, its countdown
          (if any) follows whatever your admin has configured here.
        </div>
      </section>
    );
  }

  async function setRule(contentFormat: ContentFormat, editorId: string | null, hours: number) {
    try {
      await api("/task-time-rules", { method: "POST", body: JSON.stringify({ contentFormat, editorId, hours }) });
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

  const globalFor = (f: ContentFormat) => rules?.find((r) => r.content_format === f && !r.editor_id) ?? null;
  const overrideFor = (editorId: string, f: ContentFormat) => rules?.find((r) => r.content_format === f && r.editor_id === editorId) ?? null;

  return (
    <section className="screen">
      <div className="sectitle">
        <span className="dot" />Global defaults
        <span className="s">how long each content format should take, org-wide</span>
      </div>
      <div className="card pad">
        {rules === null ? (
          <div className="hint">Loading…</div>
        ) : (
          <div className="grid g4">
            {FORMATS.map((f) => (
              <FormatBox key={f} format={f} rule={globalFor(f)} onSave={(hours) => setRule(f, null, hours)} onRemove={globalFor(f) ? () => removeRule(globalFor(f)!.id) : undefined} />
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
        {rules === null || !editors ? (
          <div className="hint">Loading…</div>
        ) : editors.length === 0 ? (
          <div className="hint">No team members yet — add editors under Settings first.</div>
        ) : (
          <div className="bulk-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Team member</th>
                  {FORMATS.map((f) => (
                    <th key={f} style={{ textAlign: "center" }}>{FORMAT_ICON[f]} {FORMAT_LABEL[f]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {editors.map((ed) => (
                  <tr key={ed.id}>
                    <td style={{ fontWeight: 650 }}>{ed.name}</td>
                    {FORMATS.map((f) => (
                      <td key={f} style={{ textAlign: "center" }}>
                        <OverrideCell
                          rule={overrideFor(ed.id, f)}
                          globalHours={globalFor(f)?.hours ?? null}
                          onSave={(hours) => setRule(f, ed.id, hours)}
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
          Type a number and click away to save — that person always gets exactly that budget for that format, ignoring
          the global default above. Clear the cell (and click away) to remove the override and fall back to the default.
        </div>
      </div>
    </section>
  );
}

function FormatBox({
  format, rule, onSave, onRemove,
}: {
  format: ContentFormat;
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
      <label className="f">{FORMAT_ICON[format]} {FORMAT_LABEL[format]}</label>
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
