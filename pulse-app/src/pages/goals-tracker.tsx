import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useAuth } from "@/lib/auth-context";
import { Modal } from "@/components/modal";

// Goals — admin-only manual goal-tracking dashboard. Every number is entered by
// an admin (POST /goal-tracker + progress updates); nothing wires to Task Points
// or Goal Setting. See server/src/routes/goal-tracker.js.

type GoalType = "revenue" | "overall_team" | "project_work" | "custom";
type Goal = {
  id: string;
  type: GoalType;
  title: string;
  description: string | null;
  unitLabel: string | null;
  targetValue: number;
  currentValue: number;
  channelId: string | null;
  channelName?: string | null;
  ownerId: string | null;
  ownerName?: string | null;
  deadline: string | null; // YYYY-MM-DD
  createdAt: string;
  updateCount?: number;
};
type GoalUpdate = { id: string; value: number; note: string | null; updatedAt: string; byName: string | null };
type Admin = { id: string; name: string | null; email: string };

const TYPE_META: Record<GoalType, { label: string; icon: string; cls: string }> = {
  revenue: { label: "Revenue", icon: "💰", cls: "rev" },
  overall_team: { label: "Overall Team", icon: "🌟", cls: "team" },
  project_work: { label: "Project / Work", icon: "📋", cls: "proj" },
  custom: { label: "Custom", icon: "🎯", cls: "custom" },
};
const TYPE_ORDER: GoalType[] = ["revenue", "overall_team", "project_work", "custom"];

// How far below the "time elapsed" pace counts as Behind rather than On track.
// Tunable — not a fixed spec.
const BEHIND_MARGIN = 0.15;

type StatusKey = "completed" | "overdue" | "ontrack" | "behind" | "open";
const STATUS_META: Record<StatusKey, { label: string; cls: string }> = {
  completed: { label: "Completed", cls: "cp" },
  overdue: { label: "Overdue", cls: "ov" },
  ontrack: { label: "On track", cls: "ok" },
  behind: { label: "Behind", cls: "bh" },
  open: { label: "In progress", cls: "op" },
};

// Derived, never stored — real math on admin-entered numbers.
function deriveStatus(g: Goal): StatusKey {
  if (g.targetValue > 0 && g.currentValue >= g.targetValue) return "completed";
  const now = new Date();
  if (g.deadline) {
    const end = new Date(g.deadline + "T23:59:59");
    if (now > end) return "overdue";
    const start = new Date(g.createdAt);
    const total = end.getTime() - start.getTime();
    const elapsed = now.getTime() - start.getTime();
    const timePct = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
    const achievedPct = g.targetValue > 0 ? g.currentValue / g.targetValue : 0;
    return achievedPct < timePct - BEHIND_MARGIN ? "behind" : "ontrack";
  }
  return "open"; // no deadline → just "In progress"
}

const CURRENCY = new Set(["₹", "$", "€", "£", "¥"]);
function fmtVal(v: number, unit: string | null): string {
  const n = Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  if (CURRENCY.has(unit)) return unit + n;
  if (unit === "%") return n + "%";
  return `${n} ${unit}`;
}
function pctOf(g: Goal): number {
  if (g.targetValue <= 0) return g.currentValue > 0 ? 100 : 0;
  return Math.round((g.currentValue / g.targetValue) * 100);
}
function fmtDate(d: string | null): string {
  if (!d) return "No deadline";
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Standalone page (sidebar › Manage › Goals). The topbar supplies the "Goals"
// title/subtitle (see PAGE_META), so the section itself is header-light.
export function GoalsTrackerPage() {
  return (
    <section className="screen">
      <GoalsTrackerSection />
    </section>
  );
}

export function GoalsTrackerSection() {
  const { isAdmin } = useWorkspaces();
  const { user } = useAuth();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [filter, setFilter] = useState<"all" | GoalType>("all");
  const [owner, setOwner] = useState<string>("all"); // "all" or an admin's user id
  const didInit = useRef(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    try {
      const [g, a] = await Promise.all([
        api<{ goals: Goal[] }>("/goal-tracker"),
        api<{ admins: Admin[] }>("/goal-tracker/admins").catch(() => ({ admins: [] as Admin[] })),
      ]);
      setGoals(g.goals);
      setAdmins(a.admins);
    } catch {
      setGoals([]);
    }
  };
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  // Open on the current admin's own goals by default (once we know who they are).
  useEffect(() => {
    if (!didInit.current && user?.id && admins.some((a) => a.id === user.id)) {
      setOwner(user.id);
      didInit.current = true;
    }
  }, [user?.id, admins]);

  const byOwner = (goals ?? []).filter((g) => owner === "all" || g.ownerId === owner);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: byOwner.length };
    for (const g of byOwner) c[g.type] = (c[g.type] ?? 0) + 1;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, owner]);

  if (!isAdmin) {
    return <div className="card pad" style={{ color: "var(--muted)" }}>Goals is available to admins only.</div>;
  }

  const shown = byOwner.filter((g) => filter === "all" || g.type === filter);
  const ownerLabel = owner === "all" ? "All admins" : (admins.find((a) => a.id === owner)?.name ?? "—");

  return (
    <div className="goalt">
      {/* Whose goals are we viewing — pick an admin (or all). */}
      <div className="goalt-owner">
        <span className="goalt-owner-l">Admin</span>
        <select className="t goalt-owner-sel" value={owner} onChange={(e) => { setOwner(e.target.value); didInit.current = true; }}>
          <option value="all">All admins</option>
          {admins.map((a) => <option key={a.id} value={a.id}>{a.name ?? a.email}</option>)}
        </select>
        <span className="goalt-owner-hint">
          {owner === "all" ? "Viewing everyone's goals" : `Viewing ${ownerLabel}'s goals`}
        </span>
      </div>

      <div className="goalt-head">
        <div className="goalt-pills">
          {(["all", ...TYPE_ORDER] as const).map((k) => (
            <button key={k} className={"goalt-pill" + (filter === k ? " active" : "")} onClick={() => setFilter(k)}>
              {k === "all" ? "All" : `${TYPE_META[k].icon} ${TYPE_META[k].label}`}
              <span className="goalt-pill-n">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>＋ New Goal</button>
      </div>

      {goals === null ? (
        <div className="card pad hint">Loading goals…</div>
      ) : shown.length === 0 ? (
        <div className="card pad home-empty">
          {goals.length === 0
            ? "No goals yet — create one with ＋ New Goal."
            : owner === "all" ? "No goals of this type." : `No goals for ${ownerLabel} yet.`}
        </div>
      ) : (
        <div className="goalt-grid">
          {shown.map((g) => {
            const st = deriveStatus(g);
            const pct = pctOf(g);
            const remaining = Math.max(0, g.targetValue - g.currentValue);
            const tm = TYPE_META[g.type];
            return (
              <button key={g.id} className="goalt-card" onClick={() => setOpenId(g.id)}>
                <div className="goalt-card-top">
                  <span className={"goalt-type " + tm.cls}>{tm.icon} {tm.label}</span>
                  <span className={"goalt-status " + STATUS_META[st].cls}>{STATUS_META[st].label}</span>
                </div>
                <div className="goalt-title">{g.title}</div>
                <div className="goalt-cardmeta">
                  {owner === "all" && g.ownerName && <span className="goalt-owner-tag">👤 {g.ownerName}</span>}
                  {g.channelName && <span className="goalt-scope">🌐 {g.channelName}</span>}
                </div>
                <div className="goalt-bar"><div className="goalt-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                <div className="goalt-nums">
                  <span><b>{fmtVal(g.currentValue, g.unitLabel)}</b><small>Achieved</small></span>
                  <span><b>{fmtVal(g.targetValue, g.unitLabel)}</b><small>Target</small></span>
                  <span><b>{fmtVal(remaining, g.unitLabel)}</b><small>Remaining</small></span>
                  <span className="goalt-pct"><b>{pct}%</b><small>of target</small></span>
                </div>
                <div className="goalt-foot">🗓 {fmtDate(g.deadline)}</div>
              </button>
            );
          })}
        </div>
      )}

      {creating && (
        <CreateGoalModal
          admins={admins}
          defaultOwner={owner !== "all" ? owner : (user?.id ?? "")}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}
      {openId && <GoalDetailModal id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

// ---- Create ----
function CreateGoalModal({ admins, defaultOwner, onClose, onCreated }: { admins: Admin[]; defaultOwner: string; onClose: () => void; onCreated: () => void }) {
  const { workspaces } = useWorkspaces();
  const [type, setType] = useState<GoalType>("revenue");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [initialValue, setInitialValue] = useState("");
  const [channelId, setChannelId] = useState("");
  const [ownerId, setOwnerId] = useState(defaultOwner);
  const [deadline, setDeadline] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) { toast.error("Give the goal a title."); return; }
    const target = Number(targetValue);
    if (!Number.isFinite(target)) { toast.error("Enter a numeric target."); return; }
    setSaving(true);
    try {
      await api("/goal-tracker", {
        method: "POST",
        body: JSON.stringify({
          type, title: title.trim(), description: description.trim() || null,
          unitLabel: unitLabel.trim() || null, targetValue: target,
          initialValue: initialValue === "" ? 0 : Number(initialValue),
          channelId: channelId || null, ownerId: ownerId || null, deadline: deadline || null,
        }),
      });
      toast.success("Goal created.");
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create goal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title="New Goal">
      <div className="goalt-form">
        <div className="field">
          <label className="f">Type</label>
          <div className="goalt-typesel">
            {TYPE_ORDER.map((t) => (
              <button key={t} type="button" className={"goalt-typeopt" + (type === t ? " on" : "")} onClick={() => setType(t)}>
                <span>{TYPE_META[t].icon}</span>{TYPE_META[t].label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="f">Title *</label>
          <input className="t" placeholder="e.g. Q3 Revenue" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label className="f">Description</label>
          <textarea className="t" rows={2} placeholder="Optional — what this goal covers" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid g3">
          <div className="field">
            <label className="f">Unit</label>
            <input className="t" placeholder="₹, tasks, %…" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} />
          </div>
          <div className="field">
            <label className="f">Target *</label>
            <input className="t" type="number" placeholder="0" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
          </div>
          <div className="field">
            <label className="f">Starting value</label>
            <input className="t" type="number" placeholder="0" value={initialValue} onChange={(e) => setInitialValue(e.target.value)} />
          </div>
        </div>
        <div className="grid g2">
          <div className="field">
            <label className="f">Deadline</label>
            <input className="t" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <div className="field">
            <label className="f">Channel scope</label>
            <select className="t" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Org-wide (all channels)</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="f">Goal For *</label>
          <select className="t" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {admins.length === 0 && <option value="">—</option>}
            {admins.map((a) => <option key={a.id} value={a.id}>{a.name ?? a.email}</option>)}
          </select>
          <div className="hint" style={{ marginTop: 4 }}>Which admin this goal belongs to.</div>
        </div>
      </div>
      <div className="formfoot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Create Goal"}</button>
      </div>
    </Modal>
  );
}

// ---- Detail ----
function GoalDetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [updates, setUpdates] = useState<GoalUpdate[]>([]);
  const [newValue, setNewValue] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const d = await api<{ goal: Goal; updates: GoalUpdate[] }>(`/goal-tracker/${id}`);
      setGoal(d.goal);
      setUpdates(d.updates);
    } catch {
      toast.error("Could not load goal.");
      onClose();
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function submitProgress() {
    const v = Number(newValue);
    if (newValue === "" || !Number.isFinite(v)) { toast.error("Enter a numeric value."); return; }
    setSaving(true);
    try {
      await api(`/goal-tracker/${id}/progress`, { method: "POST", body: JSON.stringify({ value: v, note: note.trim() || null }) });
      setNewValue(""); setNote("");
      toast.success("Progress updated.");
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update progress.");
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!goal || !window.confirm(`Delete goal "${goal.title}"? This removes its progress history too.`)) return;
    try {
      await api(`/goal-tracker/${id}`, { method: "DELETE" });
      toast.success("Goal deleted.");
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete goal.");
    }
  }

  if (!goal) return <Modal onClose={onClose} title="Goal"><div className="hint" style={{ padding: 20 }}>Loading…</div></Modal>;

  const st = deriveStatus(goal);
  const pct = pctOf(goal);
  const remaining = Math.max(0, goal.targetValue - goal.currentValue);
  const tm = TYPE_META[goal.type];
  const chartData = updates.map((u) => ({
    t: new Date(u.updatedAt).getTime(),
    label: new Date(u.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    value: u.value,
  }));
  // Keep the Target reference line in view: scale the Y axis to whichever is
  // larger — the target or the highest recorded value — with a little headroom.
  const yMax = Math.max(goal.targetValue, ...chartData.map((d) => d.value), 1) * 1.08;

  return (
    <Modal onClose={onClose} title="Goal" wide>
      <div className="goalt-detail">
        <div className="goalt-detail-head">
          <span className={"goalt-type " + tm.cls}>{tm.icon} {tm.label}</span>
          <span className={"goalt-status " + STATUS_META[st].cls}>{STATUS_META[st].label}</span>
          {goal.ownerName && <span className="goalt-owner-tag">👤 {goal.ownerName}</span>}
          {goal.channelName && <span className="goalt-scope">🌐 {goal.channelName}</span>}
          <button className="goalt-del" title="Delete goal" onClick={del}>🗑 Delete</button>
        </div>
        <h2 className="goalt-detail-title">{goal.title}</h2>
        {goal.description && <p className="goalt-detail-desc">{goal.description}</p>}

        <div className="goalt-detail-nums">
          <div><b>{fmtVal(goal.currentValue, goal.unitLabel)}</b><small>Achieved</small></div>
          <div><b>{fmtVal(goal.targetValue, goal.unitLabel)}</b><small>Target</small></div>
          <div><b>{fmtVal(remaining, goal.unitLabel)}</b><small>Remaining</small></div>
          <div><b>{pct}%</b><small>of target</small></div>
          <div><b>{fmtDate(goal.deadline)}</b><small>Deadline</small></div>
        </div>
        <div className="goalt-bar lg"><div className="goalt-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} /></div>

        {/* Update progress — fast inline entry, no navigation. */}
        <div className="goalt-update">
          <div className="goalt-update-l">Update progress</div>
          <input className="t" type="number" placeholder={`New value${goal.unitLabel ? ` (${goal.unitLabel})` : ""}`} value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <input className="t" placeholder="Note (optional) — e.g. collected September invoices" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary" onClick={submitProgress} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>

        {/* Progress over time */}
        <div className="goalt-chart-h">Progress over time</div>
        {chartData.length < 2 ? (
          <div className="hint" style={{ padding: "8px 2px 14px" }}>Add another update to see the trend.</div>
        ) : (
          <div className="goalt-chart">
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 10, right: 16, left: 4, bottom: 4 }}>
                <CartesianGrid stroke="rgba(148,163,184,0.15)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "rgba(148,163,184,0.2)" }} />
                <YAxis domain={[0, yMax]} tick={{ fill: "#94a3b8", fontSize: 12 }} tickLine={false} axisLine={false} width={44} />
                {goal.targetValue > 0 && (
                  <ReferenceLine y={goal.targetValue} stroke="#22c55e" strokeDasharray="5 4" label={{ value: "Target", fill: "#22c55e", fontSize: 11, position: "right" }} />
                )}
                <Tooltip
                  contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
                  labelStyle={{ color: "var(--muted)" }}
                  formatter={(v) => [fmtVal(Number(v), goal.unitLabel), "Value"]}
                />
                <Line type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2.5} dot={{ r: 4, fill: "#a855f7" }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* History */}
        <div className="goalt-chart-h">Update history</div>
        <div className="goalt-history">
          {[...updates].reverse().map((u) => (
            <div className="goalt-hrow" key={u.id}>
              <span className="goalt-hval">{fmtVal(u.value, goal.unitLabel)}</span>
              <span className="goalt-hnote">{u.note || <span className="st dim">—</span>}</span>
              <span className="goalt-hmeta">{u.byName ?? "—"} · {new Date(u.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
