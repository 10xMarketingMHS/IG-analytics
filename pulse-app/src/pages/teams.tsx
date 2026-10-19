import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { fileToSquareDataUrl } from "@/lib/image";
import type { AppUser, Editor, Role } from "@/lib/types";

// The add / edit window for one team member — used by Team › Roster.

// Positions: the team's hierarchy, most senior first. A job title only — what
// someone can do in Pulse is their Role. Picked from this list; a position
// saved before the list was fixed still shows on that person until changed.
export const DESIGNATIONS = ["Manager", "Asst. Manager", "Team Lead", "Editor", "Viewer"];
// Where a position sits in the hierarchy (0 = most senior); anything else
// comes after the list, and no position last.
export const positionRank = (p: string | null | undefined): number => {
  const i = DESIGNATIONS.indexOf((p ?? "").trim());
  return i >= 0 ? i : p?.trim() ? DESIGNATIONS.length : DESIGNATIONS.length + 1;
};

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
export const ROLE_HINT: Record<Role, string> = {
  admin: "Full access — manage content, taxonomy, team & users.",
  editor: "Create & edit posts and tasks. No access to settings management.",
  viewer: "Read-only — can view dashboards & posts.",
};

// The roster's role picker: Super Admin is an admin who can also manage other
// admins; No login is someone on the team who can't sign in.
export type RoleKey = "super" | Role | "none";
export const ROLE_KEY_LABEL: Record<RoleKey, string> = { super: "Super Admin", admin: "Admin", editor: "Editor", viewer: "Viewer", none: "No login" };
export const roleKeyOf = (u: AppUser | null): RoleKey => (!u ? "none" : u.role === "admin" && u.isSuperAdmin ? "super" : u.role);
const LOGIN_HINT: Record<Exclude<RoleKey, "none">, string> = {
  super: "Everything an admin can do, and managing other admins.",
  ...ROLE_HINT,
};

// One row = one person, however they exist in the system: on the roster
// (assignable to posts/tasks), with a login (can sign in), or both — the
// common case. Merged by editor_id so "add a person" is one flow either way.
export type TeamRow = { editor: Editor | null; user: AppUser | null };

export function TeamMemberModal({ row, onClose, onSaved, existingEmails, startWithLogin, startRole, canManageAdmins = true, onRemoveEditor, onRemoveLogin }: {
  row: TeamRow; onClose: () => void; onSaved: () => void; existingEmails: string[];
  // Open with "Give login access" already ticked (the roster's Give login),
  // and the role picked on the row.
  startWithLogin?: boolean;
  startRole?: RoleKey;
  // Only a Super Admin can make someone an admin or Super Admin.
  canManageAdmins?: boolean;
  onRemoveEditor?: (ed: Editor) => void;
  onRemoveLogin?: (u: AppUser) => void;
}) {
  const { editor, user } = row;
  const editingEditor = Boolean(editor);
  // An admin's position and code are a Super Admin's to set; on your own row
  // you can still change your name and photo.
  const adminLocked = !canManageAdmins && !!user && user.role === "admin";
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(editor?.name ?? user?.name ?? "");
  const [designation, setDesignation] = useState(editor?.designation ?? "");
  const [code, setCode] = useState(editor?.employee_code ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(editor?.image_url ?? null);

  const [giveLogin, setGiveLogin] = useState(Boolean(user) || Boolean(startWithLogin));
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Exclude<RoleKey, "none">>(() => {
    const k = user ? roleKeyOf(user) : startRole;
    return k && k !== "none" ? k : "editor";
  });
  const wasRole = user ? roleKeyOf(user) : null;

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
        if (code.trim().toUpperCase() !== (editor.employee_code ?? "")) patch.employeeCode = code.trim();
        if (imageUrl !== editor.image_url) patch.imageUrl = imageUrl ?? "";
        if (Object.keys(patch).length) await api(`/editors/${editor.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      } else {
        const { editor: created } = await api<{ editor: Editor }>("/editors", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), designation, imageUrl: imageUrl ?? "", ...(code.trim() ? { employeeCode: code.trim() } : {}) }),
        });
        editorId = created.id;
      }

      if (giveLogin && !user) {
        // Brand-new login, linked to the editor record above in one step.
        await api("/users", {
          method: "POST",
          body: JSON.stringify({ email: email.trim(), name: name.trim(), password, role: role === "super" ? "admin" : role, superAdmin: role === "super", editorId }),
        });
      } else if (giveLogin && user && (role !== wasRole || user.editor_id !== editorId)) {
        // Link the login to its roster record whenever they differ — including a
        // login that was not on the roster yet, whose record was just created above.
        const patch: Record<string, unknown> = {};
        if (role !== wasRole) {
          if (role === "super") patch.superAdmin = true;
          else { patch.role = role; if (user.isSuperAdmin) patch.superAdmin = false; }
        }
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
              <select className="t" value={designation} onChange={(e) => setDesignation(e.target.value)} disabled={adminLocked}
                title={adminLocked ? "Only a Super Admin can change an admin's position" : undefined}>
                <option value="">No position</option>
                {(designation && !DESIGNATIONS.includes(designation) ? [designation, ...DESIGNATIONS] : DESIGNATIONS).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <div className="hint" style={{ marginTop: 5 }}>Manager › Asst. Manager › Team Lead › Editor › Viewer. A job title only; what they can do is set by their Role.</div>
            </div>
            <div className="field">
              <label className="f">Employee code</label>
              <input className="t" placeholder="e.g. MHS001" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ maxWidth: 200 }}
                disabled={adminLocked} title={adminLocked ? "Only a Super Admin can change an admin's employee code" : undefined} />
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
                  <select className="t" value={role} onChange={(e) => setRole(e.target.value as Exclude<RoleKey, "none">)}
                    disabled={!canManageAdmins && (wasRole === "admin" || wasRole === "super")}>
                    {(["super", "admin", "editor", "viewer"] as const).map((k) => (
                      <option key={k} value={k} disabled={(k === "super" || k === "admin") && !canManageAdmins && wasRole !== k}>{ROLE_KEY_LABEL[k]}</option>
                    ))}
                  </select>
                  <div className="hint" style={{ marginTop: 5 }}>
                    {LOGIN_HINT[role]}{!canManageAdmins && " Only a Super Admin can make someone an admin."}
                  </div>
                </div>
              </div>
            )}
            {error && <p className="login-err">{error}</p>}
          </div>
          <div className="mfoot">
            {editor && onRemoveEditor && !adminLocked && (
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
