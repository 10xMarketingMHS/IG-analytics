import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, API_BASE } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";

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

type GoalRow = { contentFormatId: string; name: string; icon: string; category: string | null; jc: number | null; jph: number };
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
  goalJC: number; actualJC: number; jph: number; goalHours: number; actualHours: number; balance: number; achievement: number | null;
};

export function GoalSettingSection() {
  const { isAdmin } = useWorkspaces();
  const { editors } = useEditors();
  const [month, setMonth] = useState(thisMonthStr());
  const [view, setView] = useState<"goals" | "performance">("goals");
  const [editorId, setEditorId] = useState<string>("");
  // Periods that actually have goal data — drives the Performance picker + export.
  const [dataMonths, setDataMonths] = useState<string[]>([]);
  useEffect(() => {
    if (isAdmin) api<{ months: string[] }>("/goals/months").then((d) => setDataMonths(d.months)).catch(() => {});
  }, [isAdmin]);
  // When viewing Performance, snap to a month that has data if the current one doesn't.
  useEffect(() => {
    if (view === "performance" && dataMonths.length && !dataMonths.includes(month)) setMonth(dataMonths[0]);
  }, [view, dataMonths]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAdmin) {
    return (
      <>
        <div className="sectitle"><span className="dot" />Goal Setting<span className="s">monthly capacity & performance</span></div>
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>Only admins can set and review monthly goals.</div>
      </>
    );
  }

  const activeEditors = (editors ?? []).filter((e) => e.active);

  return (
    <>
      <div className="sectitle">
        <span className="dot" />Goal Setting
        <span className="s">monthly job-count targets, capacity & performance — per editor</span>
      </div>
      <div className="card pad" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="seg" style={{ marginBottom: 0 }}>
          <button type="button" className={view === "goals" ? "on" : ""} onClick={() => setView("goals")}>🎯 Set Goals</button>
          <button type="button" className={view === "performance" ? "on" : ""} onClick={() => setView("performance")}>📈 Performance</button>
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
        <label className="f" style={{ margin: 0 }}>Editor{" "}
          <select className="t" style={{ maxWidth: 200, display: "inline-block" }} value={editorId} onChange={(e) => setEditorId(e.target.value)}>
            <option value="">Select an editor…</option>
            {activeEditors.map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
          </select>
        </label>
        {view === "performance" && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: "auto" }}
            disabled={!dataMonths.includes(month)}
            onClick={() => exportMonth(month)}>⬇ Export .xlsx</button>
        )}
      </div>

      {!editorId ? (
        <div className="card pad"><div className="hint">Pick an editor to {view === "goals" ? "set their goals" : "see their performance"} for {month}.</div></div>
      ) : view === "goals" ? (
        <GoalEditor key={editorId + month} editorId={editorId} month={`${month}-01`} />
      ) : (
        <PerformanceReport key={editorId + month} editorId={editorId} month={`${month}-01`} />
      )}
    </>
  );
}

function GoalEditor({ editorId, month }: { editorId: string; month: string }) {
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
          <CapInputs label={`Org default (${month.slice(0, 7)})`} cap={orgCap} onChange={setOrgCap} onSave={() => saveCapacity("org", orgCap)} />
          <CapInputs
            label="This editor (override)"
            cap={override ?? { workingDays: orgCap.workingDays, hoursPerDay: orgCap.hoursPerDay }}
            faded={!override}
            onChange={setOverride}
            onSave={() => override && saveCapacity("editor", override)}
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
                    <input className="t" style={{ maxWidth: 90, textAlign: "center" }} type="number" min="0" placeholder="—"
                      value={jc[r.contentFormatId] ?? ""} onChange={(e) => setJc((s) => ({ ...s, [r.contentFormatId]: e.target.value }))} />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input className="t" style={{ maxWidth: 90, textAlign: "center" }} type="number" min="0" step="0.25"
                      value={jph[r.contentFormatId] ?? ""} onChange={(e) => setJph((s) => ({ ...s, [r.contentFormatId]: e.target.value }))} />
                  </td>
                  <td style={{ textAlign: "center", fontWeight: 650 }}>{round1(planned)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="hint" style={{ marginTop: 10 }}>Leave JC blank for a type this editor has no goal for this month. JPH pre-fills from the content type's time budget — edit if this editor differs.</div>
      </div>

      {/* Summary */}
      <div className="home-stats" style={{ marginTop: 16 }}>
        <div className="home-stat"><div className="hs-v">{round1(capacityHours)}</div><div className="hs-l">Capacity (hrs)</div></div>
        <div className="home-stat accent"><div className="hs-v">{round1(plannedHours)}</div><div className="hs-l">Planned hours</div></div>
        <div className={"home-stat " + (balance < 0 ? "danger" : "info")}><div className="hs-v">{round1(balance)}</div><div className="hs-l">Balance (hrs)</div></div>
        <div className={"home-stat " + status.cls}><div className="hs-v">{round1(util)}%</div><div className="hs-l">Utilization · {status.label}</div></div>
      </div>

      <div className="formfoot" style={{ marginTop: 16 }}>
        <div className="hint" style={{ margin: 0, flex: 1 }}>Goals never feed scoring or rank — this is capacity planning only.</div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={saveGoals}>{busy ? "Saving…" : "Save goals"}</button>
      </div>
    </>
  );
}

function CapInputs({ label, cap, faded, onChange, onSave }: { label: string; cap: Cap; faded?: boolean; onChange: (c: Cap) => void; onSave: () => void }) {
  return (
    <div style={{ opacity: faded ? 0.7 : 1 }}>
      <div className="f" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input className="t" style={{ maxWidth: 90 }} type="number" min="0" max="31" value={cap.workingDays}
          onChange={(e) => onChange({ ...cap, workingDays: Number(e.target.value) })} title="Working days" />
        <span className="st dim">days ×</span>
        <input className="t" style={{ maxWidth: 80 }} type="number" min="0" max="24" step="0.5" value={cap.hoursPerDay}
          onChange={(e) => onChange({ ...cap, hoursPerDay: Number(e.target.value) })} title="Hours per day" />
        <span className="st dim">h/day</span>
        <button type="button" className="btn btn-sm" onClick={onSave}>Save</button>
      </div>
    </div>
  );
}

function PerformanceReport({ editorId, month }: { editorId: string; month: string }) {
  const [rows, setRows] = useState<PerfRow[] | null>(null);
  useEffect(() => {
    api<{ rows: PerfRow[] }>(`/goals/performance?editorId=${editorId}&month=${month}`)
      .then((d) => setRows(d.rows))
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load performance."));
  }, [editorId, month]);

  if (!rows) return <div className="card pad"><div className="hint">Loading…</div></div>;
  const tot = rows.reduce((a, r) => ({ gj: a.gj + r.goalJC, aj: a.aj + r.actualJC, gh: a.gh + r.goalHours, ah: a.ah + r.actualHours }), { gj: 0, aj: 0, gh: 0, ah: 0 });
  return (
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
  );
}
