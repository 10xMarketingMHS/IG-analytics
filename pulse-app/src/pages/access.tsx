import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { PermissionKey } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { gradFor } from "@/lib/editor-visuals";
import type { AssignScope } from "@/lib/use-review-access";
import { useContentFormats } from "@/lib/use-content-formats";
import type { ContentFormatDef } from "@/lib/types";
import { SI, Seg } from "@/pages/settings-ui";

// Settings › Access (Pulse Redesign v5) — admin or the access_manage grant.
// Pick a person, tick the extra permissions they get on top of their role,
// Save. Grants are meaningless for admins, so admins are left out of the
// picker. Assign tasks can be limited to some content types, and to some
// people. Who reviews a task isn't handed out here: it follows one rule
// (server/src/review-route.js).

type UserRow = { id: string; email: string; name: string | null; active: boolean; editor_id: string | null; role: "admin" | "editor" | "viewer" };

const ROLE_LABEL: Record<UserRow["role"], string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

// Two groups: self-scoped grants (only ever act on the grantee's own data) and
// admin-capability grants (act as admin for one feature — cross-user/org power).
const GROUPS: { scope: "self" | "admin"; l: string; d: string }[] = [
  { scope: "self", l: "Self-scoped", d: "Acts only on their own work" },
  { scope: "admin", l: "Admin capabilities", d: "Power over other people's work and org settings" },
];
const PERMISSIONS: { key: PermissionKey; label: string; desc: string; scope: "self" | "admin"; warn?: boolean }[] = [
  { key: "create_post", label: "Create posts", scope: "self", desc: "Add posts; any editing task it creates is assigned to them, never to anyone else" },
  { key: "task_settings", label: "Task settings", scope: "admin", desc: "Task types, points and time budgets — affects everyone's scoring" },
  { key: "channels", label: "Channels & integrations", scope: "admin", desc: "Add, rename and delete channels; connect Instagram, Facebook and YouTube" },
  { key: "content_taxonomy", label: "Content taxonomy", scope: "admin", desc: "Pillars, avatars, content types and formats" },
  { key: "access_manage", label: "Manage access", scope: "admin", desc: "Grant or revoke permissions for other people", warn: true },
  { key: "assign_tasks", label: "Assign tasks", scope: "admin", desc: "Assign tasks to other editors, not only themselves" },
  { key: "hold_tasks", label: "Hold any task", scope: "admin", desc: "Pause or resume anyone's task, not only their own" },
  { key: "edit_goals", label: "Edit goals", scope: "admin", desc: "Set any editor's goals and capacity" },
  { key: "discipline", label: "Discipline", scope: "admin", desc: "Give discipline ratings for the whole team" },
];

const CATEGORY_LABEL: Record<string, string> = { social: "Social", ad: "Ads", service: "Services", project: "Projects" };

// Content-type chips, grouped by category, for the Assign tasks limit.
function FormatPicker({ formats, picked, onChange, label }: { formats: ContentFormatDef[]; picked: string[]; onChange: (ids: string[]) => void; label: string }) {
  if (formats.length === 0) return <span className="st-note">No content types yet. Add them in Settings › Content.</span>;
  const groups = [...new Set(formats.map((f) => f.category ?? "other"))];
  return (
    <div className="st-fmts" aria-label={label}>
      {groups.map((g) => (
        <div className="st-fmtgroup" key={g}>
          <span className="st-fmtcat">{CATEGORY_LABEL[g] ?? "Other"}</span>
          <div className="st-people">
            {formats.filter((f) => (f.category ?? "other") === g).map((f) => {
              const on = picked.includes(f.id);
              return (
                <button key={f.id} type="button" className={"st-pill fmt" + (on ? " on" : "")} aria-pressed={on}
                  onClick={() => onChange(on ? picked.filter((id) => id !== f.id) : [...picked, f.id])}>
                  {f.icon && <span className="st-fmticon" aria-hidden="true">{f.icon}</span>}
                  {f.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function AccessSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [userId, setUserId] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Assign tasks: any task, or only these content types; to anyone, or only these people.
  const [assignAll, setAssignAll] = useState(true);
  const [assignFmts, setAssignFmts] = useState<string[]>([]);
  const [assignAnyone, setAssignAnyone] = useState(true);
  const [assignWho, setAssignWho] = useState<string[]>([]);
  // What's saved, to tell when there's something to save.
  type Snap = { checked: Record<string, boolean>; assignAll: boolean; assignFmts: string[]; assignAnyone: boolean; assignWho: string[] };
  const [saved, setSaved] = useState<Snap | null>(null);
  const { editors } = useEditors();
  const { contentFormats } = useContentFormats();
  const formats = useMemo(() => (contentFormats ?? []).filter((f) => f.active), [contentFormats]);

  useEffect(() => {
    api<{ users: UserRow[] }>("/users")
      .then((d) => {
        const list = d.users.filter((u) => u.role !== "admin" && u.active);
        setUsers(list);
        setUserId((cur) => cur || list[0]?.id || "");
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load people."));
  }, []);

  // Load the picked person's current grants.
  useEffect(() => {
    if (!userId) { setChecked({}); setSaved(null); return; }
    setLoading(true);
    api<{ permissions: PermissionKey[]; assignScope?: AssignScope }>(`/access/grants?userId=${userId}`)
      .then((d) => {
        const c = Object.fromEntries(PERMISSIONS.map((p) => [p.key, d.permissions.includes(p.key)]));
        const af = d.assignScope?.formats ?? [];
        const aAll = af.length === 0;
        const aw = d.assignScope?.editors ?? [];
        const aAny = aw.length === 0;
        setChecked(c); setAssignAll(aAll); setAssignFmts(af); setAssignAnyone(aAny); setAssignWho(aw);
        setSaved({ checked: c, assignAll: aAll, assignFmts: af, assignAnyone: aAny, assignWho: aw });
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load their access."))
      .finally(() => setLoading(false));
  }, [userId]);

  async function save() {
    setSaving(true);
    try {
      const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p.key, !!checked[p.key]]));
      const assignScope: AssignScope = assignAll && assignAnyone ? null
        : { ...(assignAll ? {} : { formats: assignFmts }), ...(assignAnyone ? {} : { editors: assignWho }) };
      await api("/access/grants", { method: "PUT", body: JSON.stringify({ userId, permissions, assignScope }) });
      setSaved({ checked, assignAll, assignFmts, assignAnyone, assignWho });
      toast.success("Access saved.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save access.");
    } finally {
      setSaving(false);
    }
  }

  const person = users?.find((u) => u.id === userId) ?? null;
  const editorOf = (u: UserRow | null) => (u?.editor_id ? (editors ?? []).find((e) => e.id === u.editor_id) ?? null : null);
  const ed = editorOf(person);
  const nameOf = (u: UserRow) => u.name || ed?.name || u.email.split("@")[0];
  // Who they could assign to — everyone active except themselves.
  const reviewable = useMemo(() => (editors ?? []).filter((e) => e.active && e.id !== person?.editor_id), [editors, person?.editor_id]);
  const extra = Object.values(saved?.checked ?? {}).filter(Boolean).length;
  const dirty = !!saved && !sameJson(saved, { checked, assignAll, assignFmts, assignAnyone, assignWho });
  // A content-type limit needs at least one type picked, a people limit one person.
  const missingType = !!checked.assign_tasks && !assignAll && assignFmts.length === 0;
  const missingPerson = !!checked.assign_tasks && !assignAnyone && assignWho.length === 0;

  return (
    <>
      <section className="st-card">
        {users === null ? (
          <div className="st-empty">Loading…</div>
        ) : users.length === 0 ? (
          <div className="st-empty">Nobody to give permissions to yet — everyone with a login is an admin.</div>
        ) : (
          <div className="st-who">
            {ed?.image_url
              ? <img className="st-ava" src={ed.image_url} alt="" />
              : <span className="st-ava" style={{ background: gradFor(person ? nameOf(person) : "?") }}>{person ? initials(nameOf(person)) : "?"}</span>}
            <select className="st-in" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
              {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email} · {ROLE_LABEL[u.role]}</option>)}
            </select>
            {person && <span className="st-chip">{ROLE_LABEL[person.role]}</span>}
            <span className="st-note">{extra ? `${extra} extra permission${extra === 1 ? "" : "s"} on top of ${person ? ROLE_LABEL[person.role] : "their role"}` : "No extra permissions"}</span>
            <Link to="/my-team?tab=roster" className="st-link">Change role{SI.arrow}</Link>
          </div>
        )}
      </section>

      {userId && (loading ? (
        <section className="st-card"><div className="st-empty">Loading…</div></section>
      ) : GROUPS.map((g) => (
        <section className="st-card" key={g.scope}>
          <div className="st-cardhead"><b>{g.l}</b><span>{g.d}</span></div>
          {PERMISSIONS.filter((p) => p.scope === g.scope).map((p) => (
            <div className="st-perm" key={p.key}>
              <label>
                <input type="checkbox" checked={!!checked[p.key]} onChange={(e) => setChecked((c) => ({ ...c, [p.key]: e.target.checked }))} />
                <span className="st-box" aria-hidden="true">{SI.check}</span>
                <span><b>{p.label}</b><small>{p.desc}</small></span>
                {p.warn && <span className="st-chip warn">{SI.warning}Can widen own access</span>}
              </label>
              {p.key === "assign_tasks" && checked.assign_tasks && (
                <div className="st-scope">
                  <div className="st-scopeline">
                    Which tasks
                    <Seg label="Which tasks" value={assignAll ? "all" : "types"} options={[["all", "All content types"], ["types", "Selected content types"]]}
                      onChange={(v) => setAssignAll(v === "all")} />
                  </div>
                  {!assignAll && (
                    <>
                      <FormatPicker formats={formats} picked={assignFmts} onChange={setAssignFmts} label="Content types they can assign" />
                      <span className="st-note">They can hand out only these tasks to other people. Their own tasks aren't limited.</span>
                    </>
                  )}
                  <div className="st-scopeline">
                    Who to
                    <Seg label="Who they can assign to" value={assignAnyone ? "all" : "people"} options={[["all", "Anyone"], ["people", "Selected people"]]}
                      onChange={(v) => setAssignAnyone(v === "all")} />
                  </div>
                  {!assignAnyone && (
                    reviewable.length === 0 ? <span className="st-note">No other team members yet.</span> : (
                      <>
                        <div className="st-people" aria-label="People they can assign to">
                          {reviewable.map((e) => {
                            const on = assignWho.includes(e.id);
                            return (
                              <button key={e.id} type="button" className={"st-pill" + (on ? " on" : "")} aria-pressed={on}
                                onClick={() => setAssignWho((w) => (on ? w.filter((id) => id !== e.id) : [...w, e.id]))}>
                                {e.image_url
                                  ? <img className="st-ava sm" src={e.image_url} alt="" />
                                  : <span className="st-ava sm" style={{ background: gradFor(e.name) }}>{initials(e.name)}</span>}
                                {e.name}
                              </button>
                            );
                          })}
                        </div>
                        <span className="st-note">Only these people show when they assign a task. They can still make tasks for themselves.</span>
                      </>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
      )))}

      {userId && !loading && (
        <section className="st-card">
          <div className="st-foot" style={{ borderTop: 0 }}>
            <span className="st-note">{missingType ? "Pick at least one content type, or choose All." : missingPerson ? "Pick at least one person, or choose Anyone." : "Permissions add to the person's role — they never take anything away."}</span>
            <button type="button" className="st-btn grad" disabled={!dirty || saving || missingType || missingPerson} onClick={save}>{SI.check}{saving ? "Saving…" : dirty ? "Save access" : "Saved"}</button>
          </div>
        </section>
      )}
    </>
  );
}
