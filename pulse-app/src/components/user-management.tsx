import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import type { AppUser, Role } from "@/lib/types";

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};
const ROLE_HINT: Record<Role, string> = {
  admin: "Full access — manage content, taxonomy, editors & users.",
  editor: "Create & edit posts. No access to settings management.",
  viewer: "Read-only — can view dashboards & posts.",
};

function gradFor(seed: string) {
  const grads = [
    "linear-gradient(135deg,#6366f1,#8b5cf6)",
    "linear-gradient(135deg,#0d9488,#0ea5e9)",
    "linear-gradient(135deg,#f59e0b,#ef4444)",
    "linear-gradient(135deg,#ec4899,#8b5cf6)",
  ];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return grads[h % grads.length];
}

export function UserManagement() {
  const { active, isAdmin } = useWorkspaces();
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<{ users: AppUser[] }>("/users")
      .then(({ users }) => setUsers(users))
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  // Non-admins never see the management UI.
  if (!isAdmin) {
    return (
      <>
        <div className="sectitle"><span className="dot" />Team &amp; roles<span className="s">your access</span></div>
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          You're signed in as a <b style={{ color: "var(--text)" }}>{active?.role ?? "member"}</b> of this
          workspace. Only admins can manage users &amp; roles.
        </div>
      </>
    );
  }

  async function changeRole(u: AppUser, role: Role) {
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role }) });
      toast.success(`${u.email} is now ${ROLE_LABEL[role]}.`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to change role.");
      load();
    }
  }

  async function toggleActive(u: AppUser) {
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active: !u.active }) });
      toast.success(u.active ? "Account deactivated." : "Account reactivated.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update account.");
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

  async function revoke(u: AppUser) {
    if (!window.confirm(`Revoke ${u.email}'s access to this workspace?`)) return;
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      toast.success("Access revoked.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to revoke access.");
    }
  }

  return (
    <>
      <div className="sectitle">
        <span className="dot" />User management
        <span className="s">admins manage accounts, roles &amp; access</span>
      </div>
      <div className="card pad">
        {users === null ? (
          <div className="hint">Loading…</div>
        ) : (
          users.map((u) => (
            <div className="member" key={u.id}>
              <div className="avatar" style={{ background: gradFor(u.email), opacity: u.active ? 1 : 0.5 }}>
                {(u.name || u.email).charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 13.5 }}>
                  {u.name || u.email.split("@")[0]}
                  {u.isSelf && <span style={{ color: "var(--muted)", fontWeight: 500 }}> · you</span>}
                  {!u.active && <span className="stbadge st-planned" style={{ marginLeft: 8 }}>deactivated</span>}
                </b>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{u.email}</div>
              </div>

              <select
                className="mini"
                value={u.role}
                title={ROLE_HINT[u.role]}
                onChange={(e) => changeRole(u, e.target.value as Role)}
              >
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>

              <button className="linkbtn" onClick={() => resetPassword(u)} title="Set a new password">
                Reset password
              </button>
              <button
                className="linkbtn"
                onClick={() => toggleActive(u)}
                disabled={u.isSelf}
                style={{ color: u.active ? "var(--amber)" : "var(--good)" }}
              >
                {u.active ? "Deactivate" : "Reactivate"}
              </button>
              <button
                className="linkbtn"
                onClick={() => revoke(u)}
                disabled={u.isSelf}
                style={{ color: "var(--rose)" }}
              >
                Remove
              </button>
            </div>
          ))
        )}
        <button className="btn" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>
          ＋ Add user
        </button>
        <div className="hint" style={{ marginTop: 10 }}>
          Roles apply to <b>{active?.name ?? "this workspace"}</b>. Add a user in another workspace from its
          own Settings. Deactivating an account blocks sign-in everywhere.
        </div>
      </div>

      {adding && <AddUserModal onClose={() => setAdding(false)} onSaved={load} />}
    </>
  );
}

function AddUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), name: name.trim(), password, role }),
      });
      toast.success("User added.");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add user.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-bg show" onClick={onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ fontSize: 18 }}>👤</span>
          <h3>Add user</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="mbody">
            <div className="field">
              <label className="f">Email <span className="req">*</span></label>
              <input className="t" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label className="f">Name</label>
              <input className="t" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
            </div>
            <div className="field">
              <label className="f">Temporary password <span className="req">*</span></label>
              <input className="t" type="text" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" />
              <div className="hint" style={{ marginTop: 5 }}>Share this with the user; they sign in with it.</div>
            </div>
            <div className="field">
              <label className="f">Role</label>
              <select className="t" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <div className="hint" style={{ marginTop: 5 }}>{ROLE_HINT[role]}</div>
            </div>
            {error && <p className="login-err">{error}</p>}
          </div>
          <div className="mfoot">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Adding…" : "Add user"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
