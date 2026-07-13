import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { fileToSquareDataUrl } from "@/lib/image";
import type { Editor } from "@/lib/types";

const DESIGNATIONS = [
  "Video Editor", "Motion Designer", "Graphic Designer", "Copywriter", "Thumbnail Designer",
];

export function EditorModal({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!editor;
  const [name, setName] = useState(editor?.name ?? "");
  const [designation, setDesignation] = useState(editor?.designation ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(editor?.image_url ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImageUrl(await fileToSquareDataUrl(file));
    } catch {
      toast.error("Couldn't process that image.");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = JSON.stringify({ name: name.trim(), designation, imageUrl: imageUrl ?? "" });
    try {
      if (editing) {
        await api(`/editors/${editor.id}`, { method: "PATCH", body });
      } else {
        await api("/editors", { method: "POST", body });
      }
      toast.success(editing ? "Editor updated." : "Editor added.");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save editor.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editor) return;
    if (!window.confirm(`Remove editor "${editor.name}"? Their posts stay but become unassigned.`)) return;
    setSaving(true);
    try {
      await api(`/editors/${editor.id}`, { method: "DELETE" });
      toast.success("Editor removed.");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove editor.");
      setSaving(false);
    }
  }

  const initial = (name || "?").charAt(0).toUpperCase();

  return (
    <div className="modal-bg show" onClick={onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ fontSize: 18 }}>🎬</span>
          <h3>{editing ? "Edit editor" : "Add editor"}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="mbody">
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Upload profile image"
                style={{
                  width: 72, height: 72, borderRadius: 16, border: "1px solid var(--border)",
                  background: imageUrl ? undefined : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                  display: "grid", placeItems: "center", color: "#fff", fontWeight: 800,
                  fontSize: 26, overflow: "hidden", padding: 0, flex: "none", cursor: "pointer",
                }}
              >
                {imageUrl ? (
                  <img src={imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  initial
                )}
              </button>
              <div>
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  📷 {imageUrl ? "Change image" : "Upload image"}
                </button>
                {imageUrl && (
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ marginLeft: 6 }}
                    onClick={() => setImageUrl(null)}
                  >
                    Remove
                  </button>
                )}
                <div className="hint" style={{ marginTop: 6 }}>Square works best · auto-resized.</div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            </div>

            <div className="field">
              <label className="f">Name <span className="req">*</span></label>
              <input className="t" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label className="f">Designation</label>
              <input
                className="t"
                list="editor-designations"
                placeholder="e.g. Video Editor"
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
              />
              <datalist id="editor-designations">
                {DESIGNATIONS.map((d) => <option key={d} value={d} />)}
              </datalist>
            </div>
            {error && <p className="login-err">{error}</p>}
          </div>
          <div className="mfoot" style={{ justifyContent: editing ? "space-between" : "flex-end" }}>
            {editing && (
              <button
                type="button"
                className="btn"
                style={{ color: "var(--rose)", borderColor: "var(--rose)" }}
                onClick={handleDelete}
                disabled={saving}
              >
                🗑 Remove
              </button>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Add editor"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
