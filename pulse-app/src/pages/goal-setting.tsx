import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, API_BASE } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useAuth } from "@/lib/auth-context";
import { goalPointsTotal, goalBreakdown, DISCIPLINE_CRITERIA, type Ratings } from "@/lib/goal-points";

// Goal Setting — individual monthly capacity planning + performance tracking.
// Admin-only; independent of Task Points / the leaderboard. JPH is hours-per-job
// (the content type's time budget); Planned Hours = Σ(JC × JPH).

// Utilization status bands — a retunable config constant, not hardcoded inline.
// util < available → Available · ≤ nearCapacity → Near Capacity · else Overloaded.
const STATUS_BANDS = { available: 75, nearCapacity: 95 };
function statusFor(util: number): { label: string; cls: string } {
  if (util < STATUS_BANDS.available) return { label: "Available", cls: "good" };
  if (util <= STATUS_BANDS.nearCapacity) return { label: "Near Capacity", cls: "warn" };
  return { label: "Overloaded", cls: "danger" };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
function thisMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
// "2026-09" → "September 2026" (this app accumulates >1 year of history).
function fmtMonth(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
async function exportMonth(ym: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/goals/export?month=${ym}`, { credentials: "include" });
    if (!res.ok) { toast.error("Export failed."); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `goal-setting-${ym}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    toast.error("Export failed.");
  }
}
const CAT_LABEL: Record<string, string> = { social: "Social", ad: "Ads", service: "Service" };

type GoalRow = { contentFormatId: string; name: string; icon: string; category: string | null; jc: number | null; jph: number; points: number };
type Cap = { workingDays: number; hoursPerDay: number };
type GoalsResp = {
  month: string;
  capacity: { workingDays: number; hoursPerDay: number; hours: number; source: string };
  orgDefault: Cap | null;
  editorOverride: Cap | null;
  rows: GoalRow[];
};
type PerfRow = {
  contentFormatId: string; name: string; icon: string; category: string | null;
  goalJC: number; actualJC: number; jph: number; points: number; goalHours: number; actualHours: number; balance: number; achievement: number | null;
};
const whole = (n: number) => Math.round(n);

export function GoalSettingSection() {
  const { isAdmin, hasPermission } = useWorkspaces();
  const { editors } = useEditors();
  const { user } = useAuth();
  const [month, setMonth] = useState(thisMonthStr());
  const [view, setView] = useState<"goals" | "performance" | "discipline">("goals");
  const [editorId, setEditorId] = useState<string>("");
  // A goal_setting_access grant-holder (non-admin): read-only, locked to their
  // OWN editor. No user picker, no Discipline tab (that shows the whole team),
  // no export, no editing — a simplified, self-scoped view of the same pages.
  const viewerOnly = !isAdmin && hasPermission("goal_setting_access");
  const canView = isAdmin || viewerOnly;
  // Periods that actually have goal data — drives the Performance picker + export.
  const [dataMonths, setDataMonths] = useState<string[]>([]);
  useEffect(() => {
    if (canView) api<{ months: string[] }>("/goals/months").then((d) => setDataMonths(d.months)).catch(() => {});
  }, [canView]);
  // A viewer is always locked to their own editor record.
  useEffect(() => {
    if (viewerOnly) setEditorId(user?.editorId ?? "");
  }, [viewerOnly, user?.editorId]);
  // A viewer can never land on the admin-only Discipline tab.
  useEffect(() => {
    if (viewerOnly && view === "discipline") setView("goals");
  }, [viewerOnly, view]);
  // When viewing Performance, snap to a month that has data if the current one doesn't.
  useEffect(() => {
    if (view === "performance" && dataMonths.length && !dataMonths.includes(month)) setMonth(dataMonths[0]);
  }, [view, dataMonths]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canView) {
    return (
      <>
        <div className="sectitle"><span className="dot" />Goal Setting<span className="s">monthly capacity & performance</span></div>
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>Only admins can set and review monthly goals.</div>
      </>
    );
  }
  if (viewerOnly && !user?.editorId) {
    return (
      <>
        <div className="sectitle"><span className="dot" />Goal Setting<span className="s">your monthly goals & performance</span></div>
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>Your account isn't linked to a team member yet, so there are no goals to show. Ask an admin to link you under Settings → Team.</div>
      </>
    );
  }

  const activeEditors = (editors ?? []).filter((e) => e.active);

  return (
    <>
      <div className="sectitle">
        <span className="dot" />Goal Setting
        <span className="s">{viewerOnly ? "your monthly goals & performance — read-only" : "monthly job-count targets, capacity & performance — per editor"}</span>
      </div>
      <div className="card pad" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="seg" style={{ marginBottom: 0 }}>
          <button type="button" className={view === "goals" ? "on" : ""} onClick={() => setView("goals")}>🎯 Set Goals</button>
          <button type="button" className={view === "performance" ? "on" : ""} onClick={() => setView("performance")}>📈 Performance</button>
          {!viewerOnly && <button type="button" className={view === "discipline" ? "on" : ""} onClick={() => setView("discipline")}>⚖️ Discipline</button>}
        </div>
        {view === "goals" ? (
          <label className="f" style={{ margin: 0 }}>Month{" "}
            <input className="t" style={{ maxWidth: 160, display: "inline-block" }} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
        ) : (
          <label className="f" style={{ margin: 0 }}>Month{" "}
            <select className="t" style={{ maxWidth: 200, display: "inline-block" }} value={month} onChange={(e) => setMonth(e.target.value)} disabled={dataMonths.length === 0}>
              {dataMonths.length === 0 ? <option value="">No goal data yet</option>
                : dataMonths.map((m) => (<option key={m} value={m}>{fmtMonth(m)}</option>))}
            </select>
          </label>
        )}
        {!viewerOnly && view !== "discipline" && (
          <label className="f" style={{ margin: 0 }}>Editor{" "}
            <select className="t" style={{ maxWidth: 200, display: "inline-block" }} value={editorId} onChange={(e) => setEditorId(e.target.value)}>
              <option value="">Select an editor…</option>
              {activeEditors.map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
            </select>
          </label>
        )}
        {!viewerOnly && view === "performance" && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: "auto" }}
            disabled={!dataMonths.includes(month)}
            onClick={() => exportMonth(month)}>⬇ Export .xlsx</button>
        )}
      </div>

      {view === "discipline" ? (
        dataMonths.length === 0
          ? <div className="card pad"><div className="hint">No goal data yet — set goals for a month first.</div></div>
          : <DisciplineTab key={month} month={`${month}-01`} />
      ) : !editorId ? (
        <div className="card pad"><div className="hint">Pick an editor to {view === "goals" ? "set their goals" : "see their performance"} for {month}.</div></div>
      ) : view === "goals" ? (
        <GoalEditor key={editorId + month} editorId={editorId} month={`${month}-01`} readOnly={viewerOnly} />
      ) : (
        <PerformanceReport key={editorId + month} editorId={editorId} month={`${month}-01`} />
      )}
    </>
  );
}

function GoalEditor({ editorId, month, readOnly }: { editorId: string; month: string; readOnly?: boolean }) {
  const [data, setData] = useState<GoalsResp | null>(null);
  const [jc, setJc] = useState<Record<string, string>>({});
  const [jph, setJph] = useState<Record<string, string>>({});
  const [orgCap, setOrgCap] = useState<Cap>({ workingDays: 22, hoursPerDay: 8 });
  const [override, setOverride] = useState<Cap | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<GoalsResp>(`/goals?editorId=${editorId}&month=${month}`)
      .then((d) => {
        setData(d);
        setJc(Object.fromEntries(d.rows.map((r) => [r.contentFormatId, r.jc == null ? "" : String(r.jc)])));
        setJph(Object.fromEntries(d.rows.map((r) => [r.contentFormatId, String(r.jph)])));
        setOrgCap(d.orgDefault ?? { workingDays: d.capacity.workingDays, hoursPerDay: d.capacity.hoursPerDay });
        setOverride(d.editorOverride);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load goals."));
  }, [editorId, month]);
  useEffect(() => { load(); }, [load]);

  // Effective capacity = per-editor override if set, else org default.
  const effCap = override ?? orgCap;
  const capacityHours = Number(effCap.workingDays) * Number(effCap.hoursPerDay);
  const plannedHours = useMemo(
    () => (data?.rows ?? []).reduce((s, r) => {
      const c = Number(jc[r.contentFormatId] || 0);
      const h = Number(jph[r.contentFormatId] || 0);
      return s + c * h;
    }, 0),
    [data, jc, jph],
  );
  const balance = capacityHours - plannedHours;
  const util = capacityHours > 0 ? (plannedHours / capacityHours) * 100 : 0;
  const status = statusFor(util);
  // Goal points = Σ(JC × content-type points) — informational, live from the
  // form (blank JC contributes 0). Shared with Overall Progress via goalPointsTotal.
  const goalPoints = useMemo(
    () => goalPointsTotal((data?.rows ?? []).map((r) => ({
      jc: jc[r.contentFormatId]?.trim() ? Number(jc[r.contentFormatId]) : null,
      points: r.points,
    }))),
    [data, jc],
  );

  async function saveCapacity(scope: "org" | "editor", cap: Cap) {
    try {
      await api("/goals/capacity", { method: "PUT", body: JSON.stringify({ scope, editorId: scope === "editor" ? editorId : undefined, month, workingDays: Number(cap.workingDays), hoursPerDay: Number(cap.hoursPerDay) }) });
      toast.success(scope === "org" ? "Org default capacity saved." : "Editor capacity override saved.");
      load();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Couldn't save capacity."); }
  }
  async function saveGoals() {
    if (!data) return;
    setBusy(true);
    try {
      const goals = data.rows.map((r) => ({
        contentFormatId: r.contentFormatId,
        jc: jc[r.contentFormatId]?.trim() === "" || jc[r.contentFormatId] == null ? null : Number(jc[r.contentFormatId]),
        jph: Number(jph[r.contentFormatId] || 0),
      }));
      await api("/goals", { method: "PUT", body: JSON.stringify({ editorId, month, goals }) });
      toast.success("Goals saved.");
      load();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Couldn't save goals."); }
    finally { setBusy(false); }
  }

  if (!data) return <div className="card pad"><div className="hint">Loading…</div></div>;

  return (
    <>
      {/* Capacity */}
      <div className="card pad" style={{ marginBottom: 16 }}>
        <div className="sectitle" style={{ marginTop: 0 }}><span className="dot" />Monthly capacity<span className="s">working days × hours/day = capacity hours</span></div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
          <CapInputs label={`Org default (${month.slice(0, 7)})`} cap={orgCap} onChange={setOrgCap} onSave={() => saveCapacity("org", orgCap)} readOnly={readOnly} />
          <CapInputs
            label="This editor (override)"
            cap={override ?? { workingDays: orgCap.workingDays, hoursPerDay: orgCap.hoursPerDay }}
            faded={!override}
            onChange={setOverride}
            onSave={() => override && saveCapacity("editor", override)}
            readOnly={readOnly}
          />
          <div className="hint" style={{ margin: 0 }}>
            Source: <b>{data.capacity.source}</b> · Effective capacity <b>{round1(capacityHours)} h</b>
          </div>
        </div>
      </div>

      {/* Goals table */}
      <div className="card pad" style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr><th>Content Type</th><th style={{ textAlign: "center" }}>JC (target)</th><th style={{ textAlign: "center" }}>JPH (hrs/job)</th><th style={{ textAlign: "center" }}>Planned Hours</th></tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr><td colSpan={4} style={{ textAlign: "center", padding: 22, color: "var(--muted)" }}>No content types configured yet — add them in Task Settings.</td></tr>
            ) : data.rows.map((r) => {
              const planned = Number(jc[r.contentFormatId] || 0) * Number(jph[r.contentFormatId] || 0);
              return (
                <tr key={r.contentFormatId}>
                  <td>{r.icon} {r.name} {r.category && <span className="st dim">· {CAT_LABEL[r.category] ?? r.category}</span>}</td>
                  <td style={{ textAlign: "center" }}>
                    <input className="t" style={{ maxWidth: 90, textAlign: "center" }} type="number" min="0" placeholder="—" disabled={readOnly}
                      value={jc[r.contentFormatId] ?? ""} onChange={(e) => setJc((s) => ({ ...s, [r.contentFormatId]: e.target.value }))} />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input className="t" style={{ maxWidth: 90, textAlign: "center" }} type="number" min="0" step="0.25" disabled={readOnly}
                      value={jph[r.contentFormatId] ?? ""} onChange={(e) => setJph((s) => ({ ...s, [r.contentFormatId]: e.target.value }))} />
                  </td>
                  <td style={{ textAlign: "center", fontWeight: 650 }}>{round1(planned)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="hint" style={{ marginTop: 10 }}>{readOnly
          ? "These are your goals for the month, set by an admin. This view is read-only."
          : "Leave JC blank for a type this editor has no goal for this month. JPH pre-fills from the content type's time budget — edit if this editor differs."}</div>
      </div>

      {/* Summary */}
      <div className="home-stats" style={{ marginTop: 16 }}>
        <div className="home-stat"><div className="hs-v">{round1(capacityHours)}</div><div className="hs-l">Capacity (hrs)</div></div>
        <div className="home-stat accent"><div className="hs-v">{round1(plannedHours)}</div><div className="hs-l">Planned hours</div></div>
        <div className={"home-stat " + (balance < 0 ? "danger" : "info")}><div className="hs-v">{round1(balance)}</div><div className="hs-l">Balance (hrs)</div></div>
        <div className={"home-stat " + status.cls}><div className="hs-v">{round1(util)}%</div><div className="hs-l">Utilization · {status.label}</div></div>
      </div>

      {/* Goal points — a different unit (points, not hours/%), so its own card. */}
      <div className="card pad" style={{ marginTop: 12, display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <div className="hs-v" style={{ fontSize: 30, color: "var(--accent-ink, #7c3aed)" }}>{round1(goalPoints)}</div>
        <div>
          <div style={{ fontWeight: 700 }}>Goal points</div>
          <div className="hint" style={{ margin: 0 }}>Σ (JC × the content type's points) — a target, not hours.</div>
        </div>
      </div>

      <div className="formfoot" style={{ marginTop: 16 }}>
        <div className="hint" style={{ margin: 0, flex: 1 }}>This total is informational — it doesn't add to anyone's Task Points or change their rank.</div>
        {!readOnly && <button type="button" className="btn btn-primary" disabled={busy} onClick={saveGoals}>{busy ? "Saving…" : "Save goals"}</button>}
      </div>
    </>
  );
}

function CapInputs({ label, cap, faded, onChange, onSave, readOnly }: { label: string; cap: Cap; faded?: boolean; onChange: (c: Cap) => void; onSave: () => void; readOnly?: boolean }) {
  return (
    <div style={{ opacity: faded ? 0.7 : 1 }}>
      <div className="f" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input className="t" style={{ maxWidth: 90 }} type="number" min="0" max="31" value={cap.workingDays} disabled={readOnly}
          onChange={(e) => onChange({ ...cap, workingDays: Number(e.target.value) })} title="Working days" />
        <span className="st dim">days ×</span>
        <input className="t" style={{ maxWidth: 80 }} type="number" min="0" max="24" step="0.5" value={cap.hoursPerDay} disabled={readOnly}
          onChange={(e) => onChange({ ...cap, hoursPerDay: Number(e.target.value) })} title="Hours per day" />
        <span className="st dim">h/day</span>
        {!readOnly && <button type="button" className="btn btn-sm" onClick={onSave}>Save</button>}
      </div>
    </div>
  );
}

// Read-only 0–5 star display / picker.
function StarRating({ value, onChange, readOnly }: { value: number | null; onChange?: (v: number | null) => void; readOnly?: boolean }) {
  return (
    <span style={{ display: "inline-flex", gap: 1, alignItems: "center" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={readOnly}
          onClick={() => onChange?.(value === n ? null : n)}
          style={{ background: "none", border: 0, padding: 0, lineHeight: 1, fontSize: 16, cursor: readOnly ? "default" : "pointer", color: value != null && n <= value ? "#f59e0b" : "var(--border2, #cbd5e1)" }}
          title={`${n}/5`}>★</button>
      ))}
      {value == null && <span className="st dim" style={{ marginLeft: 4, fontSize: 11 }}>not set</span>}
    </span>
  );
}

function PerformanceReport({ editorId, month }: { editorId: string; month: string }) {
  const [rows, setRows] = useState<PerfRow[] | null>(null);
  const [ratings, setRatings] = useState<Ratings>({});
  useEffect(() => {
    api<{ rows: PerfRow[]; ratings: Ratings }>(`/goals/performance?editorId=${editorId}&month=${month}`)
      .then((d) => { setRows(d.rows); setRatings(d.ratings ?? {}); })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load performance."));
  }, [editorId, month]);

  if (!rows) return <div className="card pad"><div className="hint">Loading…</div></div>;
  const tot = rows.reduce((a, r) => ({ gj: a.gj + r.goalJC, aj: a.aj + r.actualJC, gh: a.gh + r.goalHours, ah: a.ah + r.actualHours }), { gj: 0, aj: 0, gh: 0, ah: 0 });
  const bd = goalBreakdown(rows, ratings);
  return (
    <>
      {/* 80/20 Overall Score breakdown */}
      {bd ? (<>
        <div className="home-stats" style={{ marginBottom: 12 }}>
          <div className="home-stat"><div className="hs-v">{whole(bd.total)}</div><div className="hs-l">Total Goal Points</div></div>
          <div className="home-stat accent"><div className="hs-v">{whole(bd.earned)}</div><div className="hs-l">Editor Earned (80%)</div></div>
          <div className="home-stat info"><div className="hs-v">{whole(bd.discipline)}{!bd.reviewed ? "*" : ""}</div><div className="hs-l">Admin Discipline (20%)</div></div>
          <div className="home-stat" style={{ borderColor: "var(--accent, #7c3aed)", borderWidth: 2 }}><div className="hs-v" style={{ color: "var(--accent-ink, #7c3aed)" }}>{whole(bd.overall)}</div><div className="hs-l">Overall Score</div></div>
        </div>
        {/* the 5 criterion ratings behind the Discipline number */}
        <div className="card pad" style={{ marginBottom: 16, display: "flex", gap: 20, flexWrap: "wrap" }}>
          {DISCIPLINE_CRITERIA.map((c) => (
            <div key={c.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="f" style={{ margin: 0 }}>{c.label}</span>
              <StarRating value={ratings[c.key] ?? null} readOnly />
            </div>
          ))}
          {!bd.reviewed && <div className="hint" style={{ margin: 0, alignSelf: "flex-end" }}>* Unrated criteria count at full marks (5) until set in the Discipline tab.</div>}
        </div>
      </>) : (
        <div className="card pad" style={{ marginBottom: 16 }}><div className="hint">No goal set this month — nothing to score.</div></div>
      )}

    <div className="card pad" style={{ overflowX: "auto" }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Content Type</th>
            <th style={{ textAlign: "center" }}>Goal JC</th><th style={{ textAlign: "center" }}>Actual JC</th>
            <th style={{ textAlign: "center" }}>Goal Hours</th><th style={{ textAlign: "center" }}>Actual Hours</th>
            <th style={{ textAlign: "center" }}>Balance</th><th style={{ textAlign: "center" }}>Achievement %</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} style={{ textAlign: "center", padding: 22, color: "var(--muted)" }}>No goals set for this editor this month.</td></tr>
          ) : rows.map((r) => {
            const pct = r.achievement;
            const cls = pct == null ? "" : pct >= 100 ? "good" : pct >= 75 ? "warn" : "danger";
            return (
              <tr key={r.contentFormatId}>
                <td>{r.icon} {r.name} {r.category && <span className="st dim">· {CAT_LABEL[r.category] ?? r.category}</span>}</td>
                <td style={{ textAlign: "center" }}>{r.goalJC}</td>
                <td style={{ textAlign: "center", fontWeight: 650 }}>{r.actualJC}</td>
                <td style={{ textAlign: "center" }}>{round1(r.goalHours)}</td>
                <td style={{ textAlign: "center" }}>{round1(r.actualHours)}</td>
                <td style={{ textAlign: "center" }} className={r.balance < 0 ? "num-over" : undefined}>{round1(r.balance)}</td>
                <td style={{ textAlign: "center" }}><span className={"task-statuschip " + cls}>{pct == null ? "—" : `${round1(pct)}%`}</span></td>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td>
              <td style={{ textAlign: "center" }}>{tot.gj}</td><td style={{ textAlign: "center" }}>{tot.aj}</td>
              <td style={{ textAlign: "center" }}>{round1(tot.gh)}</td><td style={{ textAlign: "center" }}>{round1(tot.ah)}</td>
              <td style={{ textAlign: "center" }}>{round1(tot.gh - tot.ah)}</td>
              <td style={{ textAlign: "center" }}>{tot.gj > 0 ? `${round1((tot.aj / tot.gj) * 100)}%` : "—"}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <div className="hint" style={{ marginTop: 10 }}>Actual JC = tasks of that content type completed by this editor this month. Actual Hours = Actual JC × the goal's stored JPH (an estimate, not timer data).</div>
    </div>
    </>
  );
}

// ── Discipline tab — bulk admin entry of the 20% Discipline Points per editor ──
type DiscEd = { editorId: string; editorName: string; rows: { goalJC: number; actualJC: number; points: number }[]; ratings: Ratings; note: string | null; updatedAt: string | null };
function DisciplineTab({ month }: { month: string }) {
  const [editors, setEditors] = useState<DiscEd[] | null>(null);
  const [ratings, setRatings] = useState<Record<string, Ratings>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ editors: DiscEd[] }>(`/goals/discipline?month=${month}`)
      .then((d) => {
        setEditors(d.editors);
        setRatings(Object.fromEntries(d.editors.map((e) => [e.editorId, { ...e.ratings }])));
        setNotes(Object.fromEntries(d.editors.map((e) => [e.editorId, e.note ?? ""])));
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load discipline."));
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const setRate = (edId: string, key: string, v: number | null) =>
    setRatings((s) => ({ ...s, [edId]: { ...s[edId], [key]: v } }));

  async function save() {
    if (!editors) return;
    setBusy(true);
    try {
      const entries = editors.map((ed) => ({ editorId: ed.editorId, ratings: ratings[ed.editorId] ?? {}, note: notes[ed.editorId]?.trim() || null }));
      await api("/goals/discipline", { method: "PUT", body: JSON.stringify({ month, entries }) });
      toast.success("Discipline ratings saved.");
      load();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Couldn't save."); }
    finally { setBusy(false); }
  }

  if (!editors) return <div className="card pad"><div className="hint">Loading…</div></div>;
  return (
    <>
      <div className="card pad" style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th></th><th>Editor</th><th style={{ textAlign: "center" }}>Total Goal Pts</th><th style={{ textAlign: "center" }}>Earned (80%)</th>
              <th style={{ textAlign: "center" }}>Discipline (20%)</th><th style={{ textAlign: "center" }}>Overall Score</th>
              <th style={{ textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {editors.map((ed) => {
              const r = ratings[ed.editorId] ?? {};
              const bd = goalBreakdown(ed.rows, r);
              const isOpen = expanded === ed.editorId;
              return (
                <Fragment key={ed.editorId}>
                  <tr className="clickrow" onClick={() => setExpanded(isOpen ? null : ed.editorId)}>
                    <td style={{ width: 24, color: "var(--muted)" }}>{isOpen ? "▾" : "▸"}</td>
                    <td style={{ fontWeight: 650 }}>{ed.editorName}</td>
                    {bd ? <>
                      <td style={{ textAlign: "center" }}>{whole(bd.total)}</td>
                      <td style={{ textAlign: "center" }}>{whole(bd.earned)}</td>
                      <td style={{ textAlign: "center" }}>{whole(bd.discipline)}<span className="st dim" style={{ fontSize: 10 }}> /{whole(bd.ceiling)}</span></td>
                      <td style={{ textAlign: "center", fontWeight: 700, color: "var(--accent-ink, #7c3aed)" }}>{whole(bd.overall)}</td>
                    </> : (
                      <td style={{ textAlign: "center" }} colSpan={4}><span className="st dim">No goal set</span></td>
                    )}
                    <td style={{ textAlign: "center" }}><span className={"task-statuschip " + (bd?.reviewed ? "good" : "warn")}>{bd?.reviewed ? "Reviewed" : "Pending"}</span></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: "flex", gap: 26, flexWrap: "wrap", padding: "6px 4px 10px" }}>
                          {DISCIPLINE_CRITERIA.map((c) => (
                            <div key={c.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <span className="f" style={{ margin: 0 }}>{c.label}</span>
                              <StarRating value={r[c.key] ?? null} onChange={(v) => setRate(ed.editorId, c.key, v)} />
                            </div>
                          ))}
                        </div>
                        <input className="t" placeholder="Note — why any deductions (covers all 5, optional)…"
                          value={notes[ed.editorId] ?? ""} onChange={(e) => setNotes((s) => ({ ...s, [ed.editorId]: e.target.value }))} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <div className="hint" style={{ marginTop: 10 }}>Click a row to rate the 5 criteria (0–5 each). Unrated criteria count at full marks (5) — dock only when necessary. Discipline = (Σ ratings ÷ 25) × the 20% ceiling.</div>
      </div>
      <div className="formfoot" style={{ marginTop: 14 }}>
        <div className="hint" style={{ margin: 0, flex: 1 }}>Overall Score = Earned + Discipline. Informational — it doesn't change Task Points or rank.</div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save discipline"}</button>
      </div>
    </>
  );
}
