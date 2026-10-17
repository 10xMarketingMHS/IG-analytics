import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { PermissionKey } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useTasks } from "@/lib/use-tasks";
import { gradFor } from "@/lib/editor-visuals";
import type { ReviewScope } from "@/lib/use-review-access";
import { SI, Seg } from "@/pages/settings-ui";

// Settings › Access (Pulse Redesign v5) — admin or the access_manage grant.
// Pick a person, tick the extra permissions they get on top of their role,
// Save. Grants are meaningless for admins, so admins are left out of the
// picker. Resolve reviews can be narrowed to some people, and for each of them
// to all their tasks or a hand-picked few.

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
  { key: "goal_setting_access", label: "View own goals", scope: "self", desc: "Read-only Set goals for themselves; can't change targets or give discipline" },
  { key: "task_settings", label: "Task settings", scope: "admin", desc: "Task types, points and time budgets — affects everyone's scoring" },
  { key: "channels", label: "Channels & integrations", scope: "admin", desc: "Add, rename and delete channels; connect Instagram, Facebook and YouTube" },
  { key: "content_taxonomy", label: "Content taxonomy", scope: "admin", desc: "Pillars, avatars, content types and formats" },
  { key: "access_manage", label: "Manage access", scope: "admin", desc: "Grant or revoke permissions for other people", warn: true },
  { key: "assign_tasks", label: "Assign tasks", scope: "admin", desc: "Assign tasks to other editors, not only themselves" },
  { key: "resolve_tasks", label: "Resolve reviews", scope: "admin", desc: "Approve or send back work waiting in review" },
  { key: "hold_tasks", label: "Hold any task", scope: "admin", desc: "Pause or resume anyone's task, not only their own" },
  { key: "edit_goals", label: "Edit goals", scope: "admin", desc: "Set any editor's goals and capacity" },
  { key: "discipline", label: "Discipline", scope: "admin", desc: "Give discipline ratings for the whole team" },
];

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function AccessSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [userId, setUserId] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewAll, setReviewAll] = useState(true);
  const [reviewWho, setReviewWho] = useState<Record<string, { all: boolean; taskIds: string[] }>>({});
  // What's saved, to tell when there's something to save.
  const [saved, setSaved] = useState<{ checked: Record<string, boolean>; reviewAll: boolean; reviewWho: Record<string, { all: boolean; taskIds: string[] }> } | null>(null);
  const { editors } = useEditors();
  const { tasks } = useTasks();

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
    api<{ permissions: PermissionKey[]; reviewScope: ReviewScope }>(`/access/grants?userId=${userId}`)
      .then((d) => {
        const c = Object.fromEntries(PERMISSIONS.map((p) => [p.key, d.permissions.includes(p.key)]));
        const all = !d.reviewScope;
        const who = Object.fromEntries((d.reviewScope?.editors ?? []).map((e) => [e.editorId, { all: e.taskIds == null, taskIds: e.taskIds ?? [] }]));
        setChecked(c); setReviewAll(all); setReviewWho(who);
        setSaved({ checked: c, reviewAll: all, reviewWho: who });
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load their access."))
      .finally(() => setLoading(false));
  }, [userId]);

  async function save() {
    setSaving(true);
    try {
      const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p.key, !!checked[p.key]]));
      const reviewScope: ReviewScope = reviewAll ? null : {
        editors: Object.entries(reviewWho).map(([editorId, w]) => ({ editorId, taskIds: w.all ? null : w.taskIds })),
      };
      await api("/access/grants", { method: "PUT", body: JSON.stringify({ userId, permissions, reviewScope }) });
      setSaved({ checked, reviewAll, reviewWho });
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
  // Whose work this reviewer can be handed — everyone active except themselves.
  const reviewable = useMemo(() => (editors ?? []).filter((e) => e.active && e.id !== person?.editor_id), [editors, person?.editor_id]);
  const openTasksOf = (editorId: string) => (tasks ?? []).filter((t) => t.editor_id === editorId && t.status !== "done");
  const extra = Object.values(saved?.checked ?? {}).filter(Boolean).length;
  const dirty = !!saved && !(sameJson(saved.checked, checked) && saved.reviewAll === reviewAll && sameJson(saved.reviewWho, reviewWho));

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
              {p.key === "resolve_tasks" && checked.resolve_tasks && (
                <div className="st-scope">
                  <div className="st-scopeline">
                    Whose reviews
                    <Seg label="Whose reviews" value={reviewAll ? "all" : "some"} options={[["all", "Everyone"], ["some", "Selected people"]]}
                      onChange={(v) => setReviewAll(v === "all")} />
                  </div>
                  {!reviewAll && (
                    reviewable.length === 0 ? <span className="st-note">No other team members yet.</span> : (
                      <>
                        <div className="st-people">
                          {reviewable.map((e) => {
                            const on = !!reviewWho[e.id];
                            return (
                              <button key={e.id} type="button" className={"st-pill" + (on ? " on" : "")} aria-pressed={on}
                                onClick={() => setReviewWho((s) => {
                                  const next = { ...s };
                                  if (on) delete next[e.id]; else next[e.id] = { all: true, taskIds: [] };
                                  return next;
                                })}>
                                {e.image_url
                                  ? <img className="st-ava sm" src={e.image_url} alt="" />
                                  : <span className="st-ava sm" style={{ background: gradFor(e.name) }}>{initials(e.name)}</span>}
                                {e.name.split(" ")[0]}
                              </button>
                            );
                          })}
                        </div>
                        {Object.keys(reviewWho).length > 0 && (
                          <div className="st-picks">
                            {reviewable.filter((e) => reviewWho[e.id]).map((e) => {
                              const w = reviewWho[e.id];
                              const open = openTasksOf(e.id);
                              return (
                                <div className="st-pickrow" key={e.id}>
                                  <b>{e.name}</b>
                                  <select className="st-in" aria-label={`Which of ${e.name}'s tasks`} value={w.all ? "all" : "some"}
                                    onChange={(ev) => setReviewWho((s) => ({ ...s, [e.id]: { ...w, all: ev.target.value === "all" } }))}>
                                    <option value="all">All their tasks</option>
                                    <option value="some">Only some tasks</option>
                                  </select>
                                  {!w.all && (
                                    <div className="st-tasks">
                                      {open.length === 0 && <span className="st-note">{e.name} has no open tasks right now.</span>}
                                      {open.map((t) => (
                                        <label key={t.id}>
                                          <input type="checkbox" checked={w.taskIds.includes(t.id)}
                                            onChange={(ev) => setReviewWho((s) => ({
                                              ...s,
                                              [e.id]: { ...w, taskIds: ev.target.checked ? [...w.taskIds, t.id] : w.taskIds.filter((id) => id !== t.id) },
                                            }))} />
                                          <span>{t.tid ? `${t.tid} · ` : ""}{t.title}</span>
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
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
            <span className="st-note">Permissions add to the person's role — they never take anything away.</span>
            <button type="button" className="st-btn grad" disabled={!dirty || saving} onClick={save}>{SI.check}{saving ? "Saving…" : dirty ? "Save access" : "Saved"}</button>
          </div>
        </section>
      )}
    </>
  );
}
