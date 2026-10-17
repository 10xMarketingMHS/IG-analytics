import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { gradFor } from "@/lib/editor-visuals";
import type { AppUser, Editor, Role } from "@/lib/types";
import { DESIGNATIONS, ROLE_HINT, ROLE_LABEL, TeamMemberModal, type TeamRow } from "@/pages/teams";

// Team › Roster (Pulse Redesign v5): everyone on the team in one table — their
// position, login, role and whether they can sign in — changed right on the
// row. Add member and Edit open the full window (photo, name, a new login,
// removing someone). Admin-only, like the rest of My Team.

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sv = (d: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  add: sv(<><circle cx="10" cy="8" r="4" /><path d="M3 21a7 7 0 0 1 12.5-4.3M19 14v6M16 17h6" /></>, 16),
  edit: sv(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  ok: sv(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-5" /></>, 13),
  off: sv(<><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>, 13),
  key: sv(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3" /></>, 13),
  none: sv(<><circle cx="10" cy="8" r="4" /><path d="M3 21a7 7 0 0 1 11-5.7M17 15l5 5M22 15l-5 5" /></>, 13),
};

export function TeamRoster() {
  const { active } = useWorkspaces();
  const { editors, refetch: refetchEditors } = useEditors();
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [modal, setModal] = useState<{ row: TeamRow; login?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadUsers = useCallback(() => {
    api<{ users: AppUser[] }>("/users").then(({ users }) => setUsers(users)).catch(() => setUsers([]));
  }, []);
  useEffect(() => { loadUsers(); }, [loadUsers]);
  function refetchAll() { refetchEditors(); loadUsers(); }

  const loading = editors === null || users === null;
  const rows: TeamRow[] = loading ? [] : [
    ...editors.map((ed) => ({ editor: ed, user: users.find((u) => u.editor_id === ed.id) ?? null })),
    ...users.filter((u) => !u.editor_id).map((u) => ({ editor: null, user: u })),
  ];
  const withLogin = rows.filter((r) => r.user).length;

  async function run(key: string, fn: () => Promise<unknown>, ok: string, fail: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      refetchAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : fail);
    } finally {
      setBusy(null);
    }
  }
  const setPosition = (ed: Editor, designation: string) =>
    run(ed.id, () => api(`/editors/${ed.id}`, { method: "PATCH", body: JSON.stringify({ designation }) }),
      designation ? `${ed.name} is now ${designation}.` : `${ed.name}'s position cleared.`, "Couldn't change the position.");
  const setRole = (u: AppUser, role: Role) =>
    run(u.id, () => api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
      `${u.name || u.email} is now ${ROLE_LABEL[role]}.`, "Couldn't change the role.");
  function resetPassword(u: AppUser) {
    const password = window.prompt(`Set a new password for ${u.email} (min 6 characters)`);
    if (!password) return;
    if (password.length < 6) { toast.error("Password must be at least 6 characters."); return; }
    run(u.id, () => api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ password }) }),
      "Password reset. Tell them the temporary password — they can change it under My Profile.", "Couldn't reset the password.");
  }
  const toggleActive = (u: AppUser) =>
    run(u.id, () => api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active: !u.active }) }),
      u.active ? "Login deactivated." : "Login reactivated.", "Couldn't update the login.");
  function removeEditor(ed: Editor) {
    if (!window.confirm(`Remove "${ed.name}" from the team? Their posts stay but become unassigned. Any login they have keeps working, just unlinked.`)) return;
    setModal(null);
    run(ed.id, () => api(`/editors/${ed.id}`, { method: "DELETE" }), "Removed from the team.", "Couldn't remove them.");
  }
  function removeLogin(u: AppUser) {
    if (!window.confirm(`Remove ${u.email}'s login? They stay on the team, they just can't sign in.`)) return;
    setModal(null);
    run(u.id, () => api(`/users/${u.id}`, { method: "DELETE" }), "Login removed.", "Couldn't remove the login.");
  }

  return (
    <div className="mt">
    <section className="mt-card mt-roster">
      <div className="mt-rhead">
        <b>Roster</b>
        <span className="mt-muted">{loading ? "Loading…" : `${rows.length} member${rows.length === 1 ? "" : "s"} · ${withLogin} with login`}</span>
        <span className="mt-grow" />
        <button type="button" className="mt-btn pri" onClick={() => setModal({ row: { editor: null, user: null } })}>{IC.add}Add member</button>
      </div>
      <div className="mt-roles">
        {(["admin", "editor", "viewer"] as Role[]).map((r) => (
          <span key={r}><b>{ROLE_LABEL[r]}</b> · {ROLE_HINT[r].replace(/\.$/, "").toLowerCase()}</span>
        ))}
      </div>
      {loading ? (
        <div className="mt-empty">Loading the team…</div>
      ) : rows.length === 0 ? (
        <div className="mt-empty">No team members yet. Add the first one.</div>
      ) : (
        <div className="mt-rscroll">
          <div className="mt-rtable" role="table" aria-label="Roster">
            <div className="mt-rrow mt-rth" role="row">
              <span role="columnheader">Member</span>
              <span role="columnheader">Position</span>
              <span role="columnheader">Login</span>
              <span role="columnheader">Role</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="r">Actions</span>
            </div>
            {rows.map((r) => {
              const key = r.editor?.id ?? r.user!.id;
              const name = r.editor?.name ?? r.user?.name ?? r.user?.email.split("@")[0] ?? "?";
              const u = r.user, ed = r.editor;
              const st = !u ? ["No login", "", IC.none] as const
                : !u.active ? ["Deactivated", "bad", IC.off] as const
                : u.resetRequestedAt ? ["Asked for reset", "warn", IC.key] as const
                : ["Active", "good", IC.ok] as const;
              const pos = ed?.designation ?? "";
              const posOpts = pos && !DESIGNATIONS.includes(pos) ? [pos, ...DESIGNATIONS] : DESIGNATIONS;
              return (
                <div className={"mt-rrow" + (u && !u.active ? " dim" : "")} role="row" key={key}>
                  <span className="mt-rwho" role="cell">
                    {ed?.image_url
                      ? <img className="mt-rava" src={ed.image_url} alt="" />
                      : <span className="mt-rava" style={{ background: gradFor(u?.email ?? name) }}>{initials(name)}</span>}
                    <span>
                      <b>{name}{u?.isSelf && <em className="mt-you">YOU</em>}</b>
                      {!ed && <small>Not on the team list</small>}
                    </span>
                  </span>
                  <span role="cell" className="mt-rpos">
                    {ed ? (
                      <select className="mt-rin" value={pos} disabled={busy === ed.id} aria-label={`${name}'s position`} onChange={(e) => setPosition(ed, e.target.value)}>
                        <option value="">No position</option>
                        {posOpts.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    ) : <span className="mt-muted">—</span>}
                  </span>
                  <span role="cell" className={"mt-rmail" + (u ? "" : " none")} title={u?.email}>{u ? u.email : "No login access"}</span>
                  <span role="cell" className="mt-rrole">
                    {u ? (
                      <select className="mt-rin" value={u.role} title={ROLE_HINT[u.role]} disabled={busy === u.id || u.isSelf} aria-label={`${name}'s role`}
                        onChange={(e) => setRole(u, e.target.value as Role)}>
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    ) : <span className="mt-muted">—</span>}
                  </span>
                  <span role="cell" className="mt-rstc">
                    <span className={"mt-rst " + st[1]} title={u?.resetRequestedAt ? `Asked on ${new Date(u.resetRequestedAt).toLocaleString()}` : undefined}>{st[2]}{st[0]}</span>
                  </span>
                  <span role="cell" className="mt-racts">
                    {u ? (
                      <>
                        <button type="button" className="mt-rlink" disabled={busy === u.id} onClick={() => resetPassword(u)}>Reset password</button>
                        {!u.isSelf && (
                          <button type="button" className={"mt-rlink " + (u.active ? "bad" : "good")} disabled={busy === u.id} onClick={() => toggleActive(u)}>
                            {u.active ? "Deactivate" : "Reactivate"}
                          </button>
                        )}
                      </>
                    ) : (
                      <button type="button" className="mt-rlink" onClick={() => setModal({ row: r, login: true })}>Give login</button>
                    )}
                    <button type="button" className="mt-ricon" title={`Edit ${name}`} aria-label={`Edit ${name}`} onClick={() => setModal({ row: r })}>{IC.edit}</button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="mt-rnote">
        Roles apply to <b>{active?.name ?? "this workspace"}</b>. Deactivating a login blocks sign-in everywhere; removing it (in Edit) only takes
        away access here — the person stays on the team.
      </p>
      {modal && (
        <TeamMemberModal
          row={modal.row} startWithLogin={modal.login} onClose={() => setModal(null)} onSaved={refetchAll}
          existingEmails={(users ?? []).map((x) => x.email.toLowerCase())}
          onRemoveEditor={removeEditor} onRemoveLogin={removeLogin}
        />
      )}
    </section>
    </div>
  );
}
