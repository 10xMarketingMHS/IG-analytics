import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { PermissionKey } from "@/lib/workspaces-context";

// Settings → Access — admin-only. Grant SPECIFIC named permissions to a
// SPECIFIC user, additive on top of their role. Same "pick someone, tick what
// they get, Save" shape as Set Goals — an occasional action, not a bulk table.
// Grants are meaningless for admins, so admin users are left out of the picker.

type UserRow = { id: string; email: string; name: string | null; active: boolean; editor_id: string | null; role: "admin" | "editor" | "viewer" };

// Two groups: self-scoped grants (only ever act on the grantee's own data) and
// admin-capability grants (act as admin for one feature — cross-user/org power).
const PERMISSIONS: { key: PermissionKey; label: string; desc: string; scope: "self" | "admin" }[] = [
  { key: "create_post", label: "Create posts", scope: "self", desc: "Add posts via Add Post. Any editing task it creates is always assigned to them — never to anyone else." },
  { key: "goal_setting_access", label: "View Goal Setting", scope: "self", desc: "Read-only access to their OWN Set Goals & Performance. Cannot edit targets or award discipline." },
  { key: "task_settings", label: "Task Settings", scope: "admin", desc: "Manage content formats, points per format, and time budgets — org-wide, affects everyone's scoring." },
  { key: "channels", label: "Channels & Integrations", scope: "admin", desc: "Add/rename/delete channels and connect Instagram, Facebook & YouTube." },
  { key: "content_taxonomy", label: "Content Taxonomy", scope: "admin", desc: "Edit the shared pillars, avatars, content types and formats." },
  { key: "access_manage", label: "Manage Access", scope: "admin", desc: "Grant or revoke permissions for other users. ⚠️ Lets them extend their own access too." },
  { key: "assign_tasks", label: "Assign tasks", scope: "admin", desc: "Assign tasks to other editors (not just themselves) when creating a task." },
  { key: "resolve_tasks", label: "Resolve reviews", scope: "admin", desc: "Approve or send back any task sitting in Review." },
  { key: "hold_tasks", label: "Hold any task", scope: "admin", desc: "Put on hold / resume anyone's task, not only their own." },
  { key: "edit_goals", label: "Edit Goals", scope: "admin", desc: "Set and edit any editor's goals and capacity." },
  { key: "discipline", label: "Discipline", scope: "admin", desc: "Award discipline ratings for any editor (the whole-team Discipline table)." },
];

export function AccessSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [userId, setUserId] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ users: UserRow[] }>("/users")
      .then((d) => setUsers(d.users.filter((u) => u.role !== "admin")))
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load users."));
  }, []);

  // Load the selected user's current active grants into the checklist.
  useEffect(() => {
    if (!userId) { setChecked({}); return; }
    setLoading(true);
    api<{ permissions: PermissionKey[] }>(`/access/grants?userId=${userId}`)
      .then((d) => setChecked(Object.fromEntries(PERMISSIONS.map((p) => [p.key, d.permissions.includes(p.key)]))))
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load access."))
      .finally(() => setLoading(false));
  }, [userId]);

  async function save() {
    setSaving(true);
    try {
      const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p.key, !!checked[p.key]]));
      await api("/access/grants", { method: "PUT", body: JSON.stringify({ userId, permissions }) });
      toast.success("Access updated.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save access.");
    } finally {
      setSaving(false);
    }
  }

  const activeUsers = (users ?? []).filter((u) => u.active);

  return (
    <>
      <div className="sectitle">
        <span className="dot" />Access
        <span className="s">grant specific permissions to a user — additive on top of their role</span>
      </div>

      <div className="card pad" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label className="f" style={{ margin: 0 }}>User{" "}
          <select className="t" style={{ maxWidth: 240, display: "inline-block" }} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Select a user…</option>
            {activeUsers.map((u) => (
              <option key={u.id} value={u.id}>{u.name || u.email} · {u.role}</option>
            ))}
          </select>
        </label>
      </div>

      {!userId ? (
        <div className="card pad"><div className="hint">Pick a user to grant or revoke their permissions.</div></div>
      ) : loading ? (
        <div className="card pad"><div className="hint">Loading…</div></div>
      ) : (
        <div className="card pad">
          {(["self", "admin"] as const).map((scope) => (
            <div key={scope} style={{ marginBottom: 18 }}>
              <div className="f" style={{ marginBottom: 10 }}>
                {scope === "self" ? "Self-scoped — acts only on the user's own data" : "Admin capabilities — power over other users' data & org settings"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {PERMISSIONS.filter((p) => p.scope === scope).map((p) => (
                  <label key={p.key} style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!checked[p.key]}
                      onChange={(e) => setChecked((c) => ({ ...c, [p.key]: e.target.checked }))}
                      style={{ marginTop: 3, width: 18, height: 18, flex: "none" }}
                    />
                    <span>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{p.label}</span>
                      <span style={{ display: "block", fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{p.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save access"}</button>
          </div>
        </div>
      )}
    </>
  );
}
