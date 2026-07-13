import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useWorkspaces } from "@/lib/workspaces-context";
import { ApiError } from "@/lib/api";

const LOGO_GRADIENTS = [
  "linear-gradient(135deg,#0d9488,#0ea5e9)",
  "linear-gradient(135deg,#6366f1,#8b5cf6)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#10b981,#3b82f6)",
];
function gradFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LOGO_GRADIENTS[h % LOGO_GRADIENTS.length];
}

export function WorkspaceSwitcher() {
  const { workspaces, active, switchTo, createWorkspace, renameWorkspace } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function onRename(id: string, current: string) {
    setOpen(false);
    const name = window.prompt("Rename workspace", current)?.trim();
    if (!name || name === current) return;
    try {
      await renameWorkspace(id, name);
      toast.success("Workspace renamed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Rename failed.");
    }
  }

  if (!active) return null;

  return (
    <div className="wsswitch" ref={rootRef}>
      <button className="wsbtn" onClick={() => setOpen((o) => !o)} title="Switch workspace">
        <span className="wslogo" style={{ background: gradFor(active.id) }}>
          {active.logo_url ? <img src={active.logo_url} alt="" /> : active.name.charAt(0).toUpperCase()}
        </span>
        <span className="wsnm">{active.name}</span>
        <span className="wschev">▾</span>
      </button>

      {open && (
        <div className="wsmenu">
          <div className="wshdr">Workspaces</div>
          {workspaces.map((w) => (
            <div key={w.id} className={"wsitem" + (w.id === active.id ? " on" : "")}>
              <span
                className="wslogo"
                style={{ background: gradFor(w.id), width: 24, height: 24, fontSize: 12 }}
              >
                {w.logo_url ? <img src={w.logo_url} alt="" /> : w.name.charAt(0).toUpperCase()}
              </span>
              <span
                className="wsnm"
                style={{ cursor: "pointer" }}
                onClick={() => { setOpen(false); switchTo(w.id); }}
              >
                {w.name}
              </span>
              <span
                className="edit"
                title="Rename"
                onClick={() => onRename(w.id, w.name)}
              >
                ✎
              </span>
              {w.id === active.id && <span className="tick">✓</span>}
            </div>
          ))}
          <div className="wsdiv" />
          <button className="wsitem create" onClick={() => { setOpen(false); setCreating(true); }}>
            ＋ Create workspace
          </button>
        </div>
      )}

      {creating && (
        <CreateWorkspaceModal
          onClose={() => setCreating(false)}
          onCreate={createWorkspace}
        />
      )}
    </div>
  );
}

function CreateWorkspaceModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter a workspace name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(name.trim()); // reloads into the new workspace on success
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create workspace.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-bg show" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ fontSize: 18 }}>🗂️</span>
          <h3>Create workspace</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="mbody">
            <div className="field">
              <label className="f">Workspace name <span className="req">*</span></label>
              <input
                className="t"
                autoFocus
                placeholder="e.g. I Am Doctor Farmer"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="hint" style={{ marginTop: 6 }}>
                A separate channel with its own posts, editors, taxonomy &amp; analytics.
                It starts with the default pillars &amp; avatars, which you can edit.
              </div>
            </div>
            {error && <p className="login-err">{error}</p>}
          </div>
          <div className="mfoot">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Creating…" : "Create & switch"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
