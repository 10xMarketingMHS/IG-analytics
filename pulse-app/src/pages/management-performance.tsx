import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

// Management Performance (points-based). Admin-only Settings config + Leaderboard
// tab. The measure is Overall Performance % — the Earned (80%) + Discipline (20%)
// split of Total Goal Points (the same Goal Setting computation), banded EPI/MPI/
// LPI by percentage thresholds. Nothing here is hours-denominated.

type Thresholds = { epiMinPct: number; mpiMinPct: number; isDefault?: boolean };
type Level = "EPI" | "MPI" | "LPI";
type BoardRow = {
  editorId: string; name: string | null; designation: string | null; imageUrl: string | null;
  hasGoal: boolean;
  totalGoalPoints: number; earnedPoints: number; potentialPoints: number; disciplinePoints: number;
  totalPoints: number; goalTargetNumber: number; achievedNumber: number;
  performancePct: number | null; level: Level | null; reviewed: boolean;
  thresholdsUsed: Partial<Thresholds>;
};

const LEVEL_META: Record<Level, { label: string; cls: string }> = {
  EPI: { label: "EPI", cls: "epi" },
  MPI: { label: "MPI", cls: "mpi" },
  LPI: { label: "LPI", cls: "lpi" },
};
const CAT_LABEL: Record<string, string> = { social: "Social", ad: "Ads", service: "Service" };

function thisMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtMonth(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
const pts = (n: number) => Number(n).toFixed(1);

function LevelBadge({ level }: { level: Level }) {
  const m = LEVEL_META[level];
  return <span className={"mp-badge " + m.cls}>{m.label}</span>;
}
// A level badge that renders "—" for editors with no goal that month.
function LevelCell({ level }: { level: Level | null }) {
  return level ? <LevelBadge level={level} /> : <span className="mp-nolevel">—</span>;
}

// ---------------------------------------------------------------------------
// Settings → Management Performance — EPI/MPI percentage thresholds.
// ---------------------------------------------------------------------------
export function ManagementPerformanceSettings() {
  const [thr, setThr] = useState<Thresholds | null>(null);
  const [epi, setEpi] = useState("85");
  const [mpi, setMpi] = useState("75");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Thresholds>("/management-performance/thresholds")
      .then((d) => { setThr(d); setEpi(String(d.epiMinPct)); setMpi(String(d.mpiMinPct)); })
      .catch(() => setThr({ epiMinPct: 85, mpiMinPct: 75, isDefault: true }));
  }, []);

  const epiN = Number(epi), mpiN = Number(mpi);
  const valid = epiN > 0 && mpiN > 0 && epiN <= 100 && mpiN <= 100 && mpiN <= epiN;

  async function save() {
    if (!valid) { toast.error("MPI minimum can't be higher than EPI minimum."); return; }
    setSaving(true);
    try {
      const saved = await api<Thresholds>("/management-performance/thresholds", {
        method: "PUT", body: JSON.stringify({ epiMinPct: epiN, mpiMinPct: mpiN }),
      });
      setThr(saved);
      toast.success("Thresholds saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save.");
    } finally { setSaving(false); }
  }

  if (!thr) return <div className="card pad hint">Loading…</div>;

  return (
    <div>
      <div className="sectitle"><span className="dot" />Management Performance<span className="s">EPI / MPI / LPI bands on Overall Performance %</span></div>
      <div className="card pad" style={{ maxWidth: 640 }}>
        <p className="hint" style={{ marginTop: 0 }}>
          Performance is scored as <b>Overall Performance %</b> = Total Points (Earned 80% + Discipline 20%) ÷ Total Goal
          Points. Set the two band cut-offs below; <b>LPI</b> is everything under the MPI minimum.
        </p>

        <div className="mp-thr-grid">
          <label className="f">EPI — minimum %</label>
          <div className="mp-thr-in">
            <input className="t" type="number" step="1" min="0" max="100" value={epi} onChange={(e) => setEpi(e.target.value)} />
            <span className="mp-thr-hint">and above</span>
          </div>
          <label className="f">MPI — minimum %</label>
          <div className="mp-thr-in">
            <input className="t" type="number" step="1" min="0" max="100" value={mpi} onChange={(e) => setMpi(e.target.value)} />
            <span className="mp-thr-hint">up to {epiN}%</span>
          </div>
        </div>

        <div className="mp-bands">
          <div className="mp-band epi"><LevelBadge level="EPI" /><span>{epiN}% and above</span></div>
          <div className="mp-band mpi"><LevelBadge level="MPI" /><span>{mpiN}%–{(epiN - 0.01).toFixed(2)}%</span></div>
          <div className="mp-band lpi"><LevelBadge level="LPI" /><span>below {mpiN}%</span></div>
        </div>

        {!valid && <div className="hint" style={{ color: "var(--rose)" }}>MPI minimum can't be higher than EPI minimum.</div>}

        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-primary" onClick={save} disabled={!valid || saving}>{saving ? "Saving…" : "Save thresholds"}</button>
          {thr.isDefault && <span className="hint" style={{ margin: 0 }}>Using defaults (not yet saved).</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard → Management Performance tab.
// ---------------------------------------------------------------------------
export function ManagementPerformanceBoard() {
  const [month, setMonth] = useState(thisMonthStr());
  const [months, setMonths] = useState<string[]>([]);
  const [data, setData] = useState<{ rows: BoardRow[]; thresholds: Thresholds; isCurrent?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    api<{ months: string[] }>("/management-performance/months").then((d) => setMonths(d.months)).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    api<{ rows: BoardRow[]; thresholds: Thresholds; isCurrent?: boolean }>(`/management-performance?month=${month}`)
      .then((d) => { if (active) setData(d); })
      .catch(() => { if (active) setData({ rows: [], thresholds: { epiMinPct: 85, mpiMinPct: 75 } }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month]);

  const rows = data?.rows ?? [];
  const frozen = data && data.isCurrent === false ? rows.find((r) => r.thresholdsUsed?.epiMinPct != null)?.thresholdsUsed : undefined;
  const legendThr: Thresholds = frozen?.epiMinPct != null && frozen?.mpiMinPct != null
    ? (frozen as Thresholds)
    : (data?.thresholds ?? { epiMinPct: 85, mpiMinPct: 75 });

  return (
    <div className="card pad">
      <div className="lb-statbar">
        <h3>Management Performance · {fmtMonth(month)}</h3>
        <select className="t" style={{ maxWidth: 200 }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Select month">
          {!months.includes(month) && <option value={month}>{fmtMonth(month)}</option>}
          {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
        </select>
      </div>
      <div className="hint" style={{ margin: "0 0 12px" }}>
        Overall Performance % = Total Points (Earned + Discipline) ÷ Total Goal Points.
        {" "}<LevelBadge level="EPI" /> ≥ {legendThr.epiMinPct}% · <LevelBadge level="MPI" /> {legendThr.mpiMinPct}%+ · <LevelBadge level="LPI" /> below.
        {frozen && <span className="mp-context-tag" style={{ marginLeft: 8 }}>frozen snapshot</span>}
      </div>

      {loading ? (
        <div className="hint">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="home-empty">No editors to show.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl mp-tbl">
            <thead>
              <tr><th>Employee</th><th className="num">Total Goal (Points)</th><th className="num">Total Points</th><th>Performance %</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = openId === r.editorId;
                return (
                  <Fragment key={r.editorId}>
                    <tr className={"mp-row" + (isOpen ? " open" : "")} onClick={() => setOpenId(isOpen ? null : r.editorId)} aria-expanded={isOpen}>
                      <td>
                        <div className="mp-emp">
                          <span className={"mp-caret" + (isOpen ? " open" : "")} aria-hidden>▸</span>
                          {r.imageUrl ? <img className="mp-emp-img" src={r.imageUrl} alt="" /> : <span className="mp-emp-ini">{(r.name ?? "?").charAt(0).toUpperCase()}</span>}
                          <div><b style={{ fontWeight: 650 }}>{r.name ?? "—"}</b><small>{r.designation || "Editor"}</small></div>
                        </div>
                      </td>
                      <td className="num">{r.hasGoal ? pts(r.totalGoalPoints) : <span className="mp-nolevel">no goal</span>}</td>
                      <td className="num">{r.hasGoal ? <b>{pts(r.totalPoints)}</b> : "—"}</td>
                      <td>
                        {r.hasGoal
                          ? <span className="mp-perf"><b>{r.performancePct}%</b> <LevelCell level={r.level} /></span>
                          : <span className="mp-nolevel">No goal set</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="mp-expand-row"><td colSpan={4}><PerformanceDetailInline editorId={r.editorId} month={month} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual detail — points breakdown (primary) + supplementary EOD (secondary).
// ---------------------------------------------------------------------------
type DetailResp = BoardRow & {
  editor: { id: string; name: string | null; designation: string | null; imageUrl: string | null };
  month: string;
  thresholds: Thresholds;
  taskBreakdown: { contentFormatId: string; name: string; icon: string | null; category: string | null; metricTier: "key" | "critical" | null; points: number; goal: number; achieved: number }[];
  history: { month: string; totalGoalPoints: number; totalPoints: number; performancePct: number | null; level: Level | null }[];
  eodSessions: { date: string; startedAt: string; endedAt: string | null; spanHours: number | null }[];
};

function fmtClock(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
}

function PerformanceDetailInline({ editorId, month }: { editorId: string; month: string }) {
  const [d, setD] = useState<DetailResp | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let active = true;
    setD(null); setErr(false);
    api<DetailResp>(`/management-performance/${editorId}?month=${month}`)
      .then((x) => { if (active) setD(x); })
      .catch(() => { if (active) setErr(true); });
    return () => { active = false; };
  }, [editorId, month]);

  if (err) return <div className="mp-detail"><div className="hint">Couldn't load this editor's performance.</div></div>;
  if (!d) return <div className="mp-detail"><div className="hint">Loading…</div></div>;

  const applied = d.thresholdsUsed && d.thresholdsUsed.epiMinPct != null && d.thresholdsUsed.mpiMinPct != null
    ? (d.thresholdsUsed as Thresholds) : d.thresholds;
  const bandText = d.level && applied
    ? d.level === "EPI" ? `≥ ${applied.epiMinPct}%`
      : d.level === "MPI" ? `${applied.mpiMinPct}%–${(applied.epiMinPct - 0.01).toFixed(2)}%`
        : `below ${applied.mpiMinPct}%`
    : "";

  const metricTiers = (["key", "critical"] as const)
    .map((tier) => {
      const items = d.taskBreakdown.filter((b) => b.metricTier === tier);
      return { tier, items, goal: items.reduce((s, b) => s + b.goal, 0), achieved: items.reduce((s, b) => s + b.achieved, 0) };
    })
    .filter((t) => t.items.length > 0);

  if (!d.hasGoal) {
    return (
      <div className="mp-detail">
        <div className="hint">No goal set for this editor in {fmtMonth(d.month)} — no performance score.</div>
        {d.eodSessions.length > 0 && <EodSection sessions={d.eodSessions} />}
      </div>
    );
  }

  return (
    <div className="mp-detail">
      {/* Primary: the points breakdown */}
      <div className="mp-ptsgrid">
        <div className="mp-pt lead"><span>Task Goal</span><b>{pts(d.totalGoalPoints)}</b><i>Total Goal Points</i></div>
        <div className="mp-pt"><span>Earned</span><b>{pts(d.earnedPoints)}</b><i>80% bucket</i></div>
        <div className="mp-pt muted"><span>Potential</span><b>{pts(d.potentialPoints)}</b><i>ceiling · not summed</i></div>
        <div className="mp-pt"><span>Discipline</span><b>{pts(d.disciplinePoints)}{!d.reviewed ? "*" : ""}</b><i>20% bucket</i></div>
        <div className="mp-pt accent"><span>Total Points</span><b>{pts(d.totalPoints)}</b><i>Earned + Discipline</i></div>
        <div className="mp-pt"><span>Goal Target</span><b>{d.goalTargetNumber}</b><i>tasks</i></div>
        <div className="mp-pt"><span>Achieved</span><b>{d.achievedNumber}</b><i>tasks</i></div>
        <div className="mp-pt big"><span>Overall Performance</span><b>{d.performancePct}%</b><LevelCell level={d.level} /></div>
      </div>

      <div className="mp-progress">
        <div className="mp-progress-bar">
          <div className={"mp-progress-fill " + (d.level ? LEVEL_META[d.level].cls : "")} style={{ width: `${Math.min(100, d.performancePct ?? 0)}%` }} />
        </div>
        <div className="hint" style={{ margin: "6px 0 0" }}>
          {d.level ? <>Band applied: <b>{LEVEL_META[d.level].label}</b> — Overall Performance {bandText}.</> : "No band."}
          {!d.reviewed && <span className="st dim"> · * discipline not yet fully reviewed</span>}
        </div>
      </div>

      {/* Key / Critical metric rollup */}
      {metricTiers.length > 0 && (
        <div className="mp-metrics">
          {metricTiers.map((t) => {
            const pct = t.goal > 0 ? Math.round((t.achieved / t.goal) * 100) : 0;
            return (
              <div key={t.tier} className={"mp-metric " + t.tier}>
                <span className={"mp-mtag " + t.tier}>{t.tier === "key" ? "Key Metrics" : "Critical Metrics"}</span>
                <div className="mp-metric-ga"><b>{t.achieved}</b> <span>of {t.goal}</span></div>
                <span className="mp-metric-pct">{pct}%</span>
                <span className="mp-metric-names">{t.items.map((i) => i.name).join(", ")}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Per content-type breakdown */}
      {d.taskBreakdown.length > 0 && (
        <div className="mp-bd">
          <table className="tbl">
            <thead><tr><th>Content type</th><th className="num">Points</th><th className="num">Goal</th><th className="num">Achieved</th><th className="num">%</th></tr></thead>
            <tbody>
              {d.taskBreakdown.map((b) => (
                <tr key={b.contentFormatId}>
                  <td>
                    <span className="mp-bd-fmt">
                      {b.icon && <span className="mp-bd-icon">{b.icon}</span>}
                      <span>{b.name}</span>
                      {b.metricTier && <span className={"mp-mtag sm " + b.metricTier}>{b.metricTier === "key" ? "KEY" : "CRITICAL"}</span>}
                      {b.category && <span className="mp-bd-cat">{CAT_LABEL[b.category] ?? b.category}</span>}
                    </span>
                  </td>
                  <td className="num">{b.points}</td>
                  <td className="num">{b.goal}</td>
                  <td className="num"><b>{b.achieved}</b></td>
                  <td className="num">{b.goal > 0 ? `${Math.round((b.achieved / b.goal) * 100)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Previous months — Overall Performance % over time */}
      {d.history.length > 0 && (
        <div className="mp-section">
          <div className="mp-section-t">Previous months</div>
          <table className="tbl">
            <thead><tr><th>Month</th><th className="num">Total Goal Pts</th><th className="num">Total Points</th><th className="num">Performance %</th><th>Level</th></tr></thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.month}>
                  <td>{fmtMonth(h.month)}</td>
                  <td className="num">{h.totalGoalPoints != null ? pts(h.totalGoalPoints) : "—"}</td>
                  <td className="num">{h.totalPoints != null ? pts(h.totalPoints) : "—"}</td>
                  <td className="num">{h.performancePct != null ? `${h.performancePct}%` : "—"}</td>
                  <td><LevelCell level={h.level} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Secondary context — NOT part of the score */}
      <EodSection sessions={d.eodSessions} />
    </div>
  );
}

function EodSection({ sessions }: { sessions: DetailResp["eodSessions"] }) {
  return (
    <div className="mp-section">
      <div className="mp-section-t">Start / End EOD sessions <span className="mp-context-tag">context only</span></div>
      <div className="hint" style={{ margin: "0 0 8px" }}>
        Clock-in spans for the month — supplementary context, <b>not</b> part of the performance score (that's points only).
      </div>
      {sessions.length === 0 ? (
        <div className="hint">No EOD sessions this month.</div>
      ) : (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Start</th><th>End</th><th className="num">Span</th></tr></thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={i}>
                <td>{s.date}</td>
                <td>{fmtClock(s.startedAt)}</td>
                <td>{fmtClock(s.endedAt)}</td>
                <td className="num">{s.spanHours == null ? "—" : `${s.spanHours.toFixed(1)} hr`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
