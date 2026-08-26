import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { fileToSquareDataUrl } from "@/lib/image";
import type { AppUser, Editor, Role } from "@/lib/types";

// Common titles across a content team's hierarchy — a suggestion list, not a
// closed set. Anyone can still type a custom designation (Freelancer, Intern
// at a client's own name, etc.) since every org's vocabulary differs.
// Seniority ladder, top (most senior) to bottom, followed by functional
// specialties. This is a free-text field with suggestions, not an enum —
// someone who's both a level and a specialty (e.g. a Team Lead who also
// does video edits) can just type both: "Team Lead – Video Editor".
const DESIGNATIONS = [
  "Manager", "Team Lead", "Senior Editor", "Editor", "Junior Editor", "Fresher / Intern",
  "Video Editor", "Motion Designer", "Graphic Designer", "Copywriter", "Thumbnail Designer",
];

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
const ROLE_HINT: Record<Role, string> = {
  admin: "Full access — manage content, taxonomy, team & users.",
  editor: "Create & edit posts and tasks. No access to settings management.",
  viewer: "Read-only — can view dashboards & posts.",
};

function gradFor(seed: string) {
  const grads = [
    "linear-gradient(135deg,#6366f1,#8b5cf6)", "linear-gradient(135deg,#0d9488,#0ea5e9)",
    "linear-gradient(135deg,#f59e0b,#ef4444)", "linear-gradient(135deg,#ec4899,#8b5cf6)",
  ];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return grads[h % grads.length];
}

// One row = one person, however they exist in the system: on the roster
// (assignable to posts/tasks), with a login (can sign in), or both — the
// common case. Merged by editor_id so "add a person" is one flow either way.
type Row = { editor: Editor | null; user: AppUser | null };

// Rendered as one tab inside the master Settings page (see settings.tsx) —
// no outer <section className="screen"> here, that's Settings' job.
export function TeamsSection() {
  const { active, isAdmin } = useWorkspaces();
  const { editors, refetch: refetchEditors } = useEditors();
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [modal, setModal] = useState<{ row: Row } | null>(null);

  const loadUsers = useCallback(() => {
    api<{ users: AppUser[] }>("/users").then(({ users }) => setUsers(users)).catch(() => setUsers([]));
  }, []);
  useEffect(() => { if (isAdmin) loadUsers(); }, [isAdmin, loadUsers]);

  function refetchAll() { refetchEditors(); loadUsers(); }

  if (!isAdmin) {
    return (
      <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
        You're signed in as a <b style={{ color: "var(--text)" }}>{active?.role ?? "member"}</b> of this
        workspace. Only admins can manage the team.
      </div>
    );
  }

  const loading = editors === null || users === null;
  const rows: Row[] = loading ? [] : [
    ...editors.map((ed) => ({ editor: ed, user: users.find((u) => u.editor_id === ed.id) ?? null })),
    ...users.filter((u) => !u.editor_id).map((u) => ({ editor: null, user: u })),
  ];

  async function removeEditor(ed: Editor) {
    if (!window.confirm(`Remove "${ed.name}" from the team roster? Their posts stay but become unassigned.${" "}Any login they have keeps working, just unlinked.`)) return;
    try {
      await api(`/editors/${ed.id}`, { method: "DELETE" });
      toast.success("Removed from roster.");
      refetchAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove.");
    }
  }
  async function changeRole(u: AppUser, role: Role) {
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role }) });
      toast.success(`${u.name || u.email} is now ${ROLE_LABEL[role]}.`);
      loadUsers();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to change role.");
    }
  }
  async function resetPassword(u: AppUser) {
    const password = window.prompt(`Set a new password for ${u.email} (min 6 chars)`);
    if (!password) return;
    if (password.length < 6) return toast.error("Password must be at least 6 characters.");
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      toast.success("Password reset.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reset password.");
    }
  }
  async function toggleActive(u: AppUser) {
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active: !u.active }) });
      toast.success(u.active ? "Login deactivated." : "Login reactivated.");
      loadUsers();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update.");
    }
  }
  async function removeLogin(u: AppUser) {
    if (!window.confirm(`Remove ${u.email}'s login access? They'll stay on the roster, just can't sign in.`)) return;
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      toast.success("Login access removed.");
      refetchAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove access.");
    }
  }

  return (
    <>
      <p className="hint" style={{ margin: "0 0 14px" }}>
        Everyone who works on content, whether they sign in to Pulse or not — designation shows their role on
        the team, login access (optional) controls what they can do here.
      </p>
      <div className="card pad">
        {loading ? (
          <div className="hint">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="hint">No team members yet.</div>
        ) : (
          <div className="teamlist">
            {rows.map((r) => {
              const key = r.editor?.id ?? r.user!.id;
              const displayName = r.editor?.name ?? r.user?.name ?? r.user?.email.split("@")[0] ?? "?";
              const photo = r.editor?.image_url ?? null;
              return (
                <div className="member" key={key}>
                  {photo ? (
                    <img className="avatar" src={photo} alt="" style={{ objectFit: "cover" }} />
                  ) : (
                    <div className="avatar" style={{ background: gradFor(r.user?.email ?? displayName), opacity: r.user && !r.user.active ? 0.5 : 1 }}>
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setModal({ row: r })}>
                    <b style={{ fontSize: 13.5 }}>
                      {displayName}
                      {r.user?.isSelf && <span style={{ color: "var(--muted)", fontWeight: 500 }}> · you</span>}
                      {r.user && !r.user.active && <span className="stbadge st-planned" style={{ marginLeft: 8 }}>deactivated</span>}
                    </b>
                    <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {r.editor?.designation && <span className="ptbadge pt-reel" style={{ fontSize: 10 }}>{r.editor.designation}</span>}
                      {r.user ? <span>{r.user.email}</span> : <span style={{ fontStyle: "italic" }}>No login access</span>}
                      {!r.editor && <span style={{ fontStyle: "italic" }}>Not on roster</span>}
                    </div>
                  </div>

                  {r.user ? (
                    <select className="mini" value={r.user.role} title={ROLE_HINT[r.user.role]} onChange={(e) => changeRole(r.user!, e.target.value as Role)}>
                      <option value="admin">Admin</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  ) : (
                    <span className="hint" style={{ margin: 0 }}>—</span>
                  )}

                  <button className="linkbtn" onClick={() => setModal({ row: r })}>Edit</button>
                  {r.user && <button className="linkbtn" onClick={() => resetPassword(r.user!)}>Reset password</button>}
                  {r.user && (
                    <button className="linkbtn" onClick={() => toggleActive(r.user!)} disabled={r.user.isSelf} style={{ color: r.user.active ? "var(--amber)" : "var(--good)" }}>
                      {r.user.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                  {r.user && <button className="linkbtn" onClick={() => removeLogin(r.user!)} disabled={r.user.isSelf} style={{ color: "var(--rose)" }}>Remove login</button>}
                  {r.editor && <button className="linkbtn" onClick={() => removeEditor(r.editor!)} style={{ color: "var(--rose)" }}>Remove</button>}
                </div>
              );
            })}
          </div>
        )}
        <button className="btn" style={{ marginTop: 14 }} onClick={() => setModal({ row: { editor: null, user: null } })}>
          ＋ Add team member
        </button>
        <div className="hint" style={{ marginTop: 10 }}>
          Roles apply to <b>{active?.name ?? "this workspace"}</b>. Deactivating a login blocks sign-in
          everywhere; removing it only revokes access here — the person stays on the roster.
        </div>
      </div>

      {modal && (
        <TeamMemberModal row={modal.row} onClose={() => setModal(null)} onSaved={refetchAll} />
      )}
    </>
  );
}

function TeamMemberModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const { editor, user } = row;
  const editingEditor = Boolean(editor);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(editor?.name ?? user?.name ?? "");
  const [designation, setDesignation] = useState(editor?.designation ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(editor?.image_url ?? null);

  const [giveLogin, setGiveLogin] = useState(Boolean(user));
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
      } else if (giveLogin && user && (role !== user.role || (editor && user.editor_id !== editorId))) {
        const patch: Record<string, unknown> = {};
        if (role !== user.role) patch.role = role;
        if (editor && user.editor_id !== editorId) patch.editorId = editorId;
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
          <span style={{ fontSize: 18 }}>🧑‍🤝‍🧑</span>
          <h3>{editor || user ? "Edit team member" : "Add team member"}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="mbody">
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 4 }}>
              <button
                type="button" onClick={() => fileRef.current?.click()} title="Upload profile image"
                style={{
                  width: 64, height: 64, borderRadius: 14, border: "1px solid var(--border)",
                  background: imageUrl ? undefined : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                  display: "grid", placeItems: "center", color: "#fff", fontWeight: 800,
                  fontSize: 22, overflow: "hidden", padding: 0, flex: "none", cursor: "pointer",
                }}
              >
                {imageUrl ? <img src={imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initial}
              </button>
              <div>
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  📷 {imageUrl ? "Change image" : "Upload image"}
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
              <label className="f">Designation</label>
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
            {user && <div className="hint" style={{ margin: "0 0 8px" }}>They already have a login — remove it from the team list instead of unchecking here.</div>}

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
