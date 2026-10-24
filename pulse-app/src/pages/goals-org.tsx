import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useAuth } from "@/lib/auth-context";
import { Modal } from "@/components/modal";
import {
  CreateGoalModal, deriveStatus, fmtVal, pctOf, STATUS_META, TYPE_META, TYPE_ORDER,
  type Admin, type Goal, type GoalType, type GoalUpdate, type StatusKey,
} from "@/pages/goals-tracker";

// Goals › Org goals (Pulse Redesign v5): the admin-entered goals — revenue,
// the whole team, projects, anything custom — as cards with how far along each
// is against where it should be by today. Same data and rules as before
// (server/src/routes/goal-tracker.js); only the look is new.

const sv = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const TYPE_ICON: Record<GoalType, ReactNode> = {
  revenue: sv(<><path d="M6 4h12M6 9h12M13 20 7 13h2a4 4 0 0 0 0-8" /></>, 15),
  overall_team: sv(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6a6.5 6.5 0 0 1 3.5 5.4" /></>, 15),
  project_work: sv(<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 11h6M9 15h4" /></>, 15),
  custom: sv(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r=".6" /></>, 15),
};
const IC = {
  flag: sv(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>, 18),
  ok: sv(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>, 18),
  behind: sv(<><path d="M12 8v5" /><path d="M12 16h.01" /><path d="M10.3 3.9 2.6 17.6A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0z" /></>, 18),
  done: sv(<><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4" /></>, 18),
  plus: sv(<path d="M12 5v14M5 12h14" />, 16),
  trash: sv(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>, 15),
};
// Each status's colour (text on a soft tint of itself).
const STATUS_TONE: Record<StatusKey, string> = { completed: "good", ontrack: "ac", open: "ac", behind: "warn", overdue: "bad" };

const initials = (name: string | null | undefined) =>
  (name ?? "?").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
// Where a goal should be by today, 0–1: the share of its time that has passed.
function paceOf(g: Goal): number | null {
  if (!g.deadline) return null;
  const start = new Date(g.createdAt).getTime(), end = new Date(g.deadline + "T23:59:59").getTime();
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}
function timeLeft(g: Goal): { text: string; tone: string } {
  if (!g.deadline) return { text: "No deadline", tone: "" };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(g.deadline + "T00:00:00").getTime() - today.getTime()) / 86400000);
  if (g.targetValue > 0 && g.currentValue >= g.targetValue) return { text: "Reached", tone: "good" };
  if (days < 0) return { text: `${-days} day${days === -1 ? "" : "s"} overdue`, tone: "bad" };
  if (days === 0) return { text: "Due today", tone: "warn" };
  return { text: `${days} day${days === 1 ? "" : "s"} left`, tone: "" };
}
const shortDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function OrgGoals() {
  const { isAdmin } = useWorkspaces();
  const { user } = useAuth();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [filter, setFilter] = useState<"all" | GoalType>("all");
  const [owner, setOwner] = useState<string>("all");
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
  // Open on your own goals (once we know who you are).
  useEffect(() => {
    if (!didInit.current && user?.id && admins.some((a) => a.id === user.id)) { setOwner(user.id); didInit.current = true; }
  }, [user?.id, admins]);

  const byOwner = useMemo(() => (goals ?? []).filter((g) => owner === "all" || g.ownerId === owner), [goals, owner]);
  const statusOf = useMemo(() => new Map(byOwner.map((g) => [g.id, deriveStatus(g)])), [byOwner]);
  const count = (fn: (s: StatusKey) => boolean) => byOwner.filter((g) => fn(statusOf.get(g.id)!)).length;

  if (!isAdmin) return <div className="gl-card gl-empty">Org goals are for admins.</div>;

  const shown = byOwner.filter((g) => filter === "all" || g.type === filter);
  const ownerName = owner === "all" ? "everyone" : (admins.find((a) => a.id === owner)?.name ?? "this admin");
  const stats = [
    { l: "Goals", v: byOwner.length, icon: IC.flag, tone: "ac" },
    { l: "On track", v: count((s) => s === "ontrack" || s === "open"), icon: IC.ok, tone: "good" },
    { l: "Behind or overdue", v: count((s) => s === "behind" || s === "overdue"), icon: IC.behind, tone: "warn" },
    { l: "Completed", v: count((s) => s === "completed"), icon: IC.done, tone: "rev" },
  ];

  return (
    <div className="gl-stack">
      <div className="gl-stats">
        {stats.map((s) => (
          <div key={s.l} className="gl-card gl-stat">
            <span className={"gl-stat-ic " + s.tone}>{s.icon}</span>
            <span><b>{s.v}</b><span>{s.l}</span></span>
          </div>
        ))}
      </div>

      <div className="gl-bar">
        <div className="gl-chips">
          {(["all", ...TYPE_ORDER] as const).map((k) => (
            <button key={k} type="button" className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {k !== "all" && TYPE_ICON[k]}{k === "all" ? "All" : TYPE_META[k].label}
              <span className="gl-n">{k === "all" ? byOwner.length : byOwner.filter((g) => g.type === k).length}</span>
            </button>
          ))}
        </div>
        <span className="gl-grow" />
        <select className="gl-select" value={owner} onChange={(e) => { setOwner(e.target.value); didInit.current = true; }} aria-label="Whose goals">
          <option value="all">All admins</option>
          {admins.map((a) => <option key={a.id} value={a.id}>{a.id === user?.id ? `${a.name ?? a.email} (you)` : (a.name ?? a.email)}</option>)}
        </select>
        <button type="button" className="gl-btn pri" onClick={() => setCreating(true)}>{IC.plus}New goal</button>
      </div>

      {goals === null ? (
        <div className="gl-card gl-empty">Loading goals…</div>
      ) : shown.length === 0 ? (
        <div className="gl-card gl-empty">
          {goals.length === 0 ? "No goals yet. Create one with New goal." : filter === "all" ? `No goals for ${ownerName} yet.` : "No goals of this type."}
        </div>
      ) : (
        <div className="gl-cards">
          {shown.map((g) => {
            const st = statusOf.get(g.id)!;
            const pct = pctOf(g);
            const pace = paceOf(g);
            const left = timeLeft(g);
            const tone = STATUS_TONE[st];
            return (
              <button key={g.id} type="button" className="gl-card gl-goal" onClick={() => setOpenId(g.id)}>
                <span className="gl-goaltop">
                  <span className="gl-tag ac">{TYPE_ICON[g.type]}{TYPE_META[g.type].label}</span>
                  <span className={"gl-tag " + tone}><i />{STATUS_META[st].label}</span>
                  <span className="gl-grow" />
                  {g.ownerName && <span className="gl-face" title={g.ownerName}>{initials(g.ownerName)}</span>}
                </span>
                <span className="gl-goalhd">
                  <b>{g.title}</b>
                  <span>{g.channelName ?? "Org-wide"} · {g.deadline ? `Due ${shortDate(g.deadline)}` : "No deadline"}</span>
                </span>
                <span className="gl-goalpct">
                  <span><b>{pct}%</b><span>of target</span><span className="gl-grow" /><em className={left.tone}>{left.text}</em></span>
                  <span className="gl-track">
                    <span className={"gl-fill " + tone} style={{ width: `${Math.min(100, pct)}%` }} />
                    {pace != null && st !== "completed" && <span className="gl-pace" style={{ left: `${pace * 100}%` }} title="Where it should be by today" />}
                  </span>
                </span>
                <span className="gl-goalnums">
                  <span><b>{fmtVal(g.currentValue, g.unitLabel)}</b><span>Achieved</span></span>
                  <span><b>{fmtVal(g.targetValue, g.unitLabel)}</b><span>Target</span></span>
                  <span><b>{fmtVal(Math.max(0, g.targetValue - g.currentValue), g.unitLabel)}</b><span>Remaining</span></span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {creating && (
        <CreateGoalModal admins={admins} defaultOwner={owner !== "all" ? owner : (user?.id ?? "")}
          onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
      )}
      {openId && <GoalDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

// One goal, from the right: its numbers, the pace, progress over time, and the
// box to log the new total.
function GoalDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [updates, setUpdates] = useState<GoalUpdate[]>([]);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const d = await api<{ goal: Goal; updates: GoalUpdate[] }>(`/goal-tracker/${id}`);
      setGoal(d.goal);
      setUpdates(d.updates);
    } catch {
      toast.error("Could not load the goal.");
      onClose();
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function save() {
    const v = Number(value);
    if (value === "" || !Number.isFinite(v)) { toast.error("Enter the new total as a number."); return; }
    setSaving(true);
    try {
      await api(`/goal-tracker/${id}/progress`, { method: "POST", body: JSON.stringify({ value: v, note: note.trim() || null }) });
      setValue(""); setNote("");
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
    if (!goal || !window.confirm(`Delete the goal "${goal.title}"? Its progress history goes too.`)) return;
    try {
      await api(`/goal-tracker/${id}`, { method: "DELETE" });
      toast.success("Goal deleted.");
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete the goal.");
    }
  }

  const st = goal ? deriveStatus(goal) : "open";
  const tone = STATUS_TONE[st];
  const pct = goal ? pctOf(goal) : 0;
  const pace = goal ? paceOf(goal) : null;
  const left = goal ? timeLeft(goal) : { text: "", tone: "" };
  const hist = updates.slice(-8);
  const histMax = Math.max(goal?.targetValue ?? 0, ...hist.map((u) => u.value), 1);

  return (
    <Modal onClose={onClose} title={goal?.title ?? "Goal"} variant="drawer">
      <div className="gl gl-drawer">
        {!goal ? <p className="gl-muted">Loading…</p> : (
          <>
            <div className="gl-drawertags">
              <span className="gl-tag ac">{TYPE_ICON[goal.type]}{TYPE_META[goal.type].label}</span>
              <span className={"gl-tag " + tone}><i />{STATUS_META[st].label}</span>
            </div>
            <span className="gl-muted">{goal.channelName ?? "Org-wide"} · owned by {goal.ownerName ?? "nobody yet"}</span>
            {goal.description && <p className="gl-desc">{goal.description}</p>}
            <div className="gl-dstats">
              <span><b>{fmtVal(goal.currentValue, goal.unitLabel)}</b><span>Achieved</span></span>
              <span><b>{fmtVal(goal.targetValue, goal.unitLabel)}</b><span>Target</span></span>
              <span><b>{fmtVal(Math.max(0, goal.targetValue - goal.currentValue), goal.unitLabel)}</b><span>Remaining</span></span>
              <span><b>{goal.deadline ? shortDate(goal.deadline) : "None"}</b><span>Deadline</span></span>
            </div>
            <div className="gl-dprog">
              <span><b>{pct}% done</b><span className="gl-grow" /><em className={left.tone}>{left.text}</em></span>
              <span className="gl-track lg">
                <span className={"gl-fill " + tone} style={{ width: `${Math.min(100, pct)}%` }} />
                {pace != null && st !== "completed" && <span className="gl-pace" style={{ left: `${pace * 100}%` }} title="Where it should be by today" />}
              </span>
            </div>
            <b className="gl-h">Progress over time</b>
            {hist.length < 2 ? (
              <p className="gl-muted">Log another update to see the trend.</p>
            ) : (
              <div className="gl-hist" role="img" aria-label={`Progress over the last ${hist.length} updates`}>
                {hist.map((u, i) => (
                  <span key={u.id} title={`${fmtVal(u.value, goal.unitLabel)} · ${new Date(u.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}>
                    <span className={i === hist.length - 1 ? "last" : ""} style={{ height: `${Math.max(4, (u.value / histMax) * 100)}%` }} />
                    <em>{new Date(u.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</em>
                  </span>
                ))}
              </div>
            )}
            <b className="gl-h">Update progress</b>
            <div className="gl-update">
              <input type="number" placeholder={`New total${goal.unitLabel ? ` (${goal.unitLabel})` : ""}`} value={value} onChange={(e) => setValue(e.target.value)} />
              <button type="button" className="gl-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : "Update"}</button>
            </div>
            <input className="gl-note" placeholder="Note (optional), e.g. September invoices collected" value={note} onChange={(e) => setNote(e.target.value)} />
            <span className="gl-muted sm">Enter the new total, not the change. Every update is kept in the history.</span>
            {updates.length > 0 && (
              <div className="gl-updates">
                {[...updates].reverse().map((u) => (
                  <div key={u.id}>
                    <i /><b>{fmtVal(u.value, goal.unitLabel)}</b>
                    <span className="gl-muted">{u.note || new Date(u.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                    <span className="gl-grow" /><span className="gl-muted">{u.byName ?? ""}</span>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="gl-btn danger" onClick={del}>{IC.trash}Delete goal</button>
          </>
        )}
      </div>
    </Modal>
  );
}
