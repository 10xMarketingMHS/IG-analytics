import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { fileToSquareDataUrl } from "@/lib/image";
import type { AppUser, Editor, Role } from "@/lib/types";

// The add / edit window for one team member — used by Team › Roster.

// Common titles across a content team's hierarchy — a suggestion list, not a
// closed set. Anyone can still type a custom designation (Freelancer, Intern
// at a client's own name, etc.) since every org's vocabulary differs.
// Seniority ladder, top (most senior) to bottom, followed by functional
// specialties. This is a free-text field with suggestions, not an enum —
// someone who's both a level and a specialty (e.g. a Team Lead who also
// does video edits) can just type both: "Team Lead – Video Editor".
export const DESIGNATIONS = [
  "Manager", "Team Lead", "Senior Editor", "Editor", "Junior Editor", "Fresher / Intern",
  "Video Editor", "Motion Designer", "Graphic Designer", "Copywriter", "Thumbnail Designer",
];

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
export const ROLE_HINT: Record<Role, string> = {
  admin: "Full access — manage content, taxonomy, team & users.",
  editor: "Create & edit posts and tasks. No access to settings management.",
  viewer: "Read-only — can view dashboards & posts.",
};

// One row = one person, however they exist in the system: on the roster
// (assignable to posts/tasks), with a login (can sign in), or both — the
// common case. Merged by editor_id so "add a person" is one flow either way.
export type TeamRow = { editor: Editor | null; user: AppUser | null };

export function TeamMemberModal({ row, onClose, onSaved, existingEmails, startWithLogin, onRemoveEditor, onRemoveLogin }: {
  row: TeamRow; onClose: () => void; onSaved: () => void; existingEmails: string[];
  // Open with "Give login access" already ticked (the roster's Give login).
  startWithLogin?: boolean;
  onRemoveEditor?: (ed: Editor) => void;
  onRemoveLogin?: (u: AppUser) => void;
}) {
  const { editor, user } = row;
  const editingEditor = Boolean(editor);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(editor?.name ?? user?.name ?? "");
  const [designation, setDesignation] = useState(editor?.designation ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(editor?.image_url ?? null);

  const [giveLogin, setGiveLogin] = useState(Boolean(user) || Boolean(startWithLogin));
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(user?.role ?? "editor");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try { setImageUrl(await fileToSquareDataUrl(file)); } catch { toast.error("Couldn't process that image."); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required."); return; }
    if (giveLogin && !user && !email.trim()) { setError("Email is required for login access."); return; }
    // Checked before anything is created: adding an email that already has a login
    // would overwrite that person's role (the server refuses it too).
    if (giveLogin && !user && existingEmails.includes(email.trim().toLowerCase())) {
      setError("That email already has a login on this team. Close this and use Edit on their row instead.");
      return;
    }
    if (giveLogin && !user && password.length < 6) { setError("Set a temporary password (6+ characters)."); return; }
    setSaving(true);
    setError(null);
    try {
      let editorId = editor?.id ?? null;

      if (editor) {
        // Only send fields that actually changed — PATCH is partial.
        const patch: Record<string, unknown> = {};
        if (name.trim() !== editor.name) patch.name = name.trim();
        if (designation !== (editor.designation ?? "")) patch.designation = designation;
        if (imageUrl !== editor.image_url) patch.imageUrl = imageUrl ?? "";
        if (Object.keys(patch).length) await api(`/editors/${editor.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      } else {
        const { editor: created } = await api<{ editor: Editor }>("/editors", {
          method: "POST", body: JSON.stringify({ name: name.trim(), designation, imageUrl: imageUrl ?? "" }),
        });
        editorId = created.id;
      }

      if (giveLogin && !user) {
        // Brand-new login, linked to the editor record above in one step.
        await api("/users", {
          method: "POST",
          body: JSON.stringify({ email: email.trim(), name: name.trim(), password, role, editorId }),
        });
      } else if (giveLogin && user && (role !== user.role || user.editor_id !== editorId)) {
        // Link the login to its roster record whenever they differ — including a
        // login that was not on the roster yet, whose record was just created above.
        const patch: Record<string, unknown> = {};
        if (role !== user.role) patch.role = role;
        if (user.editor_id !== editorId) patch.editorId = editorId;
        await api(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      }

      toast.success(editor || user ? "Team member updated." : "Team member added.");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const initial = (name || "?").charAt(0).toUpperCase();

  return (
    <div className="modal-bg show" onClick={onClose}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <h3>{editor || user ? "Edit team member" : "Add team member"}</h3>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={submit}>
          <div className="mbody">
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 4 }}>
              <button
                type="button" onClick={() => fileRef.current?.click()} title="Upload profile image"
                style={{
                  width: 64, height: 64, borderRadius: 14, border: "1px solid var(--border)",
                  background: imageUrl ? undefined : "var(--grad)",
                  display: "grid", placeItems: "center", color: "#fff", fontWeight: 800,
                  fontSize: 22, overflow: "hidden", padding: 0, flex: "none", cursor: "pointer",
                }}
              >
                {imageUrl ? <img src={imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initial}
              </button>
              <div>
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  {imageUrl ? "Change photo" : "Upload photo"}
                </button>
                {imageUrl && <button type="button" className="linkbtn" style={{ marginLeft: 6 }} onClick={() => setImageUrl(null)}>Remove</button>}
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            </div>

            <div className="field">
              <label className="f">Name <span className="req">*</span></label>
              <input className="t" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label className="f">Position</label>
              <input className="t" list="team-designations" placeholder="e.g. Senior Editor" value={designation} onChange={(e) => setDesignation(e.target.value)} />
              <datalist id="team-designations">
                {DESIGNATIONS.map((d) => <option key={d} value={d} />)}
              </datalist>
              <div className="hint" style={{ marginTop: 5 }}>Pick a suggestion or type your own — combine a level and a specialty if needed, e.g. "Team Lead – Video Editor".</div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 9, margin: "18px 0 4px", cursor: user ? "default" : "pointer", fontSize: 13.5, fontWeight: 700 }}>
              <input type="checkbox" checked={giveLogin} disabled={Boolean(user)} onChange={(e) => setGiveLogin(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />
              Give this person login access to Pulse
            </label>
            {user && <div className="hint" style={{ margin: "0 0 8px" }}>They already have a login — use Remove login below to take it away.</div>}

            {giveLogin && (
              <div style={{ marginTop: 10, paddingLeft: 2 }}>
                <div className="field">
                  <label className="f">Email {!user && <span className="req">*</span>}</label>
                  <input className="t" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(user)} title={user ? "Email can't be changed after creation." : undefined} />
                </div>
                {!user && (
                  <div className="field">
                    <label className="f">Temporary password <span className="req">*</span></label>
                    <input className="t" type="text" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" />
                    <div className="hint" style={{ marginTop: 5 }}>Share this with them; they sign in with it.</div>
                  </div>
                )}
                <div className="field">
                  <label className="f">Role</label>
                  <select className="t" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <div className="hint" style={{ marginTop: 5 }}>{ROLE_HINT[role]}</div>
                </div>
              </div>
            )}
            {error && <p className="login-err">{error}</p>}
          </div>
          <div className="mfoot">
            {editor && onRemoveEditor && (
              <button type="button" className="linkbtn" style={{ color: "var(--rose)", marginRight: "auto" }} onClick={() => onRemoveEditor(editor)}>Remove from team</button>
            )}
            {user && !user.isSelf && onRemoveLogin && (
              <button type="button" className="linkbtn" style={{ color: "var(--rose)", marginRight: editor && onRemoveEditor ? undefined : "auto" }} onClick={() => onRemoveLogin(user)}>Remove login</button>
            )}
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : editingEditor || user ? "Save changes" : "Add team member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
