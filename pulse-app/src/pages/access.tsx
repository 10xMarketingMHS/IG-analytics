import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { PermissionKey } from "@/lib/workspaces-context";

// Settings → Access — admin-only. Grant SPECIFIC named permissions to a
// SPECIFIC user, additive on top of their role. Same "pick someone, tick what
// they get, Save" shape as Set Goals — an occasional action, not a bulk table.
// Grants are meaningless for admins, so admin users are left out of the picker.

type UserRow = { id: string; email: string; name: string | null; active: boolean; editor_id: string | null; role: "admin" | "editor" | "viewer" };

const PERMISSIONS: { key: PermissionKey; label: string; desc: string }[] = [
  { key: "create_post", label: "Create posts", desc: "Add posts via Add Post. Any editing task it creates is always assigned to them — never to anyone else." },
  { key: "goal_setting_access", label: "View Goal Setting", desc: "Read-only access to their own Set Goals & Performance. Cannot edit targets or award discipline points." },
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
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {PERMISSIONS.map((p) => (
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
          <div style={{ marginTop: 18 }}>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save access"}</button>
          </div>
        </div>
      )}
    </>
  );
}
