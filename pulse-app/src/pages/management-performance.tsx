import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

// Management Performance (EPI / MPI / LPI). Admin-only. Two surfaces share this
// file: a Settings config section (thresholds) and a Leaderboard tab (per-editor
// table + individual detail). "Completed Hours" is the actual tracked timer time
// on tasks completed that month — NOT EOD session span, NOT Goal Setting's
// synthetic Actual Hours. See server/src/routes/management-performance.js.

type Thresholds = { epiMinPct: number; mpiMinPct: number; isDefault?: boolean };
type BoardRow = {
  editorId: string; name: string | null; designation: string | null; imageUrl: string | null;
  monthlyGoalHours: number; completedHours: number; remainingHours: number;
  completionPct: number; level: Level; taskGoal: number; taskAchieved: number; thresholdsUsed: Partial<Thresholds>;
};
type Level = "EPI" | "MPI" | "LPI";

const LEVEL_META: Record<Level, { label: string; cls: string }> = {
  EPI: { label: "EPI", cls: "epi" },
  MPI: { label: "MPI", cls: "mpi" },
  LPI: { label: "LPI", cls: "lpi" },
};

function thisMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtMonth(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
const hrs = (n: number) => `${Number(n).toFixed(1)} hr`;

function LevelBadge({ level }: { level: Level }) {
  const m = LEVEL_META[level];
  return <span className={"mp-badge " + m.cls}>{m.label}</span>;
}

// ---------------------------------------------------------------------------
// Settings → Management Performance — edit the org-wide % thresholds, with the
// resulting hour ranges shown against the org's default monthly goal.
// ---------------------------------------------------------------------------
export function ManagementPerformanceSettings() {
  const [thr, setThr] = useState<Thresholds | null>(null);
  const [orgGoal, setOrgGoal] = useState(0);
  const [epi, setEpi] = useState("93.75");
  const [mpi, setMpi] = useState("83.3");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Thresholds & { orgDefaultGoalHours: number }>("/management-performance/thresholds")
      .then((d) => {
        setThr(d);
        setOrgGoal(d.orgDefaultGoalHours);
        setEpi(String(d.epiMinPct));
        setMpi(String(d.mpiMinPct));
      })
      .catch(() => setThr({ epiMinPct: 93.75, mpiMinPct: 83.3, isDefault: true }));
  }, []);

  const epiN = Number(epi), mpiN = Number(mpi);
  const valid = epiN > 0 && mpiN > 0 && epiN <= 200 && mpiN <= 200 && mpiN <= epiN;
  const epiHrs = orgGoal > 0 ? (epiN / 100) * orgGoal : 0;
  const mpiHrs = orgGoal > 0 ? (mpiN / 100) * orgGoal : 0;

  async function save() {
    if (!valid) { toast.error("MPI minimum can't be higher than EPI minimum."); return; }
    setSaving(true);
    try {
      const saved = await api<Thresholds>("/management-performance/thresholds", {
        method: "PUT",
        body: JSON.stringify({ epiMinPct: epiN, mpiMinPct: mpiN }),
      });
      setThr(saved);
      toast.success("Thresholds saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  if (!thr) return <div className="card pad hint">Loading…</div>;

  return (
    <div>
      <div className="sectitle"><span className="dot" />Management Performance<span className="s">EPI / MPI / LPI thresholds — % of each editor's own monthly goal</span></div>
      <div className="card pad" style={{ maxWidth: 640 }}>
        <p className="hint" style={{ marginTop: 0 }}>
          Performance is scored as <b>Completed Hours ÷ that editor's monthly goal</b> (Goal Setting capacity).
          Because it's a percentage, a teammate with a different personal goal is still judged fairly against
          their own target. Hour ranges below use your org default of <b>{orgGoal > 0 ? `${orgGoal.toFixed(0)} hrs` : "—"}</b>.
        </p>

        <div className="mp-thr-grid">
          <label className="f">EPI — minimum %</label>
          <div className="mp-thr-in">
            <input className="t" type="number" step="0.01" min="0" max="200" value={epi} onChange={(e) => setEpi(e.target.value)} />
            <span className="mp-thr-hint">{orgGoal > 0 ? `≥ ${epiHrs.toFixed(1)} hrs (open-ended)` : ""}</span>
          </div>

          <label className="f">MPI — minimum %</label>
          <div className="mp-thr-in">
            <input className="t" type="number" step="0.01" min="0" max="200" value={mpi} onChange={(e) => setMpi(e.target.value)} />
            <span className="mp-thr-hint">{orgGoal > 0 ? `${mpiHrs.toFixed(1)} – ${(epiHrs - 0.1).toFixed(1)} hrs` : ""}</span>
          </div>
        </div>

        <div className="mp-bands">
          <div className="mp-band epi"><LevelBadge level="EPI" /><span>{epiN}%+{orgGoal > 0 ? ` · ${epiHrs.toFixed(0)}+ hrs` : ""}</span></div>
          <div className="mp-band mpi"><LevelBadge level="MPI" /><span>{mpiN}%–{(epiN - 0.01).toFixed(2)}%{orgGoal > 0 ? ` · ${mpiHrs.toFixed(0)}–${epiHrs.toFixed(0)} hrs` : ""}</span></div>
          <div className="mp-band lpi"><LevelBadge level="LPI" /><span>below {mpiN}%{orgGoal > 0 ? ` · under ${mpiHrs.toFixed(0)} hrs` : ""}</span></div>
        </div>

        {!valid && <div className="hint" style={{ color: "var(--danger, #d9534f)" }}>MPI minimum can't be higher than EPI minimum.</div>}

        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-primary" onClick={save} disabled={!valid || saving}>{saving ? "Saving…" : "Save thresholds"}</button>
          {thr.isDefault && <span className="hint" style={{ margin: 0 }}>Using defaults (not yet saved).</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard → Management Performance tab — per-editor table for a month.
// ---------------------------------------------------------------------------
export function ManagementPerformanceBoard() {
  const [month, setMonth] = useState(thisMonthStr());
  const [months, setMonths] = useState<string[]>([]);
  const [data, setData] = useState<{ rows: BoardRow[]; thresholds: Thresholds; orgDefaultGoalHours: number; isCurrent?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    api<{ months: string[] }>("/management-performance/months").then((d) => setMonths(d.months)).catch(() => {});
  }, []);

  // Guard against out-of-order responses: the current-month path recomputes
  // live and can take a second or two, so a slow response for a month we've
  // since navigated away from must NOT clobber the newer month's display.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    api<{ rows: BoardRow[]; thresholds: Thresholds; orgDefaultGoalHours: number; isCurrent?: boolean }>(`/management-performance?month=${month}`)
      .then((d) => { if (active) setData(d); })
      .catch(() => { if (active) setData({ rows: [], thresholds: { epiMinPct: 93.75, mpiMinPct: 83.3 }, orgDefaultGoalHours: 0 }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month]);

  const rows = data?.rows ?? [];
  // For a closed month, describe the bands with the thresholds the snapshot was
  // actually frozen at (uniform across the month's rows) rather than the current
  // live config — a later edit must not appear to reclassify a past month.
  const frozen = data && data.isCurrent === false ? rows[0]?.thresholdsUsed : undefined;
  const legendThr: Thresholds = frozen?.epiMinPct != null && frozen?.mpiMinPct != null
    ? (frozen as Thresholds)
    : (data?.thresholds ?? { epiMinPct: 93.75, mpiMinPct: 83.3 });

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
        Completed = actual tracked timer hours on tasks finished this month, measured against each editor's own monthly goal.
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
              <tr><th>Employee</th><th className="num">Goal</th><th className="num">Achieved</th><th className="num">Remaining</th><th>Performance</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = openId === r.editorId;
                return (
                  <Fragment key={r.editorId}>
                    <tr
                      className={"mp-row" + (isOpen ? " open" : "")}
                      onClick={() => setOpenId(isOpen ? null : r.editorId)}
                      aria-expanded={isOpen}
                    >
                      <td>
                        <div className="mp-emp">
                          <span className={"mp-caret" + (isOpen ? " open" : "")} aria-hidden>▸</span>
                          {r.imageUrl ? <img className="mp-emp-img" src={r.imageUrl} alt="" /> : <span className="mp-emp-ini">{(r.name ?? "?").charAt(0).toUpperCase()}</span>}
                          <div><b style={{ fontWeight: 650 }}>{r.name ?? "—"}</b><small>{r.designation || "Editor"}</small></div>
                        </div>
                      </td>
                      <td className="num">{hrs(r.monthlyGoalHours)}</td>
                      <td className="num"><b>{hrs(r.completedHours)}</b><span className="mp-pct">{r.completionPct}%</span></td>
                      <td className="num">{hrs(r.remainingHours)}</td>
                      <td><LevelBadge level={r.level} /></td>
                    </tr>
                    {isOpen && (
                      <tr className="mp-expand-row">
                        <td colSpan={5}>
                          <PerformanceDetailInline editorId={r.editorId} month={month} />
                        </td>
                      </tr>
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
// Individual Performance Detail — one editor, one month.
// ---------------------------------------------------------------------------
type DetailResp = BoardRow & {
  editor: { id: string; name: string | null; designation: string | null; imageUrl: string | null };
  month: string;
  thresholds: Thresholds;
  history: { month: string; completedHours: number; monthlyGoalHours: number; taskGoal: number; taskAchieved: number; level: Level }[];
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

  // Describe the band using the thresholds ACTUALLY APPLIED to this snapshot
  // (frozen for a past month), not the current live config — a later threshold
  // edit must not silently rewrite a closed month's meaning. Fall back to the
  // live thresholds only if the snapshot didn't record its own.
  const applied = d?.thresholdsUsed && d.thresholdsUsed.epiMinPct != null && d.thresholdsUsed.mpiMinPct != null
    ? (d.thresholdsUsed as Thresholds)
    : d?.thresholds;
  const bandText = applied && d
    ? d.level === "EPI" ? `≥ ${applied.epiMinPct}% of goal`
      : d.level === "MPI" ? `${applied.mpiMinPct}%–${(applied.epiMinPct - 0.01).toFixed(2)}% of goal`
        : `below ${applied.mpiMinPct}% of goal`
    : "";

  if (err) return <div className="mp-detail"><div className="hint">Couldn't load this editor's performance.</div></div>;
  if (!d) return <div className="mp-detail"><div className="hint">Loading…</div></div>;

  return (
        <div className="mp-detail">
          {/* Goal vs Achieved, front and centre — Hours (drives the band) + Tasks */}
          <div className="mp-ga-wrap">
            <div className="mp-ga">
              <div className="mp-ga-label">Hours</div>
              <div className="mp-ga-item"><span>Goal</span><b>{hrs(d.monthlyGoalHours)}</b></div>
              <div className="mp-ga-arrow" aria-hidden>→</div>
              <div className="mp-ga-item achieved"><span>Achieved</span><b>{hrs(d.completedHours)}</b></div>
              <div className="mp-ga-meta">
                <LevelBadge level={d.level} />
                <span className="mp-ga-sub">{d.completionPct}% of goal · {hrs(d.remainingHours)} remaining</span>
              </div>
            </div>
            <div className="mp-ga">
              <div className="mp-ga-label">Tasks</div>
              <div className="mp-ga-item"><span>Goal</span><b>{d.taskGoal}</b></div>
              <div className="mp-ga-arrow" aria-hidden>→</div>
              <div className="mp-ga-item achieved"><span>Achieved</span><b>{d.taskAchieved}</b></div>
              <div className="mp-ga-meta">
                <span className="mp-ga-sub">
                  {d.taskAchieved} of {d.taskGoal} planned jobs{d.taskGoal > 0 ? ` · ${Math.round((d.taskAchieved / d.taskGoal) * 100)}%` : ""}
                </span>
              </div>
            </div>
          </div>

          <div className="mp-progress">
            <div className="mp-progress-bar">
              <div className={"mp-progress-fill " + LEVEL_META[d.level].cls} style={{ width: `${Math.min(100, d.completionPct)}%` }} />
            </div>
            <div className="hint" style={{ margin: "6px 0 0" }}>Band applied: <b>{LEVEL_META[d.level].label}</b> — {bandText}.</div>
          </div>

          {d.history.length > 0 && (
            <div className="mp-section">
              <div className="mp-section-t">Previous months</div>
              <table className="tbl">
                <thead><tr><th>Month</th><th className="num">Goal hrs</th><th className="num">Achieved hrs</th><th className="num">Tasks (goal→done)</th><th>Level</th></tr></thead>
                <tbody>
                  {d.history.map((h) => (
                    <tr key={h.month}>
                      <td>{fmtMonth(h.month)}</td>
                      <td className="num">{hrs(h.monthlyGoalHours)}</td>
                      <td className="num">{hrs(h.completedHours)}</td>
                      <td className="num">{h.taskGoal} → {h.taskAchieved}</td>
                      <td><LevelBadge level={h.level} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mp-section">
            <div className="mp-section-t">Start / End EOD sessions <span className="mp-context-tag">context only</span></div>
            <div className="hint" style={{ margin: "0 0 8px" }}>
              Clock-in spans for the month. These are <b>not</b> counted toward Completed Hours or the EPI/MPI/LPI band —
              that uses task-timer hours only. Shown here for reference.
            </div>
            {d.eodSessions.length === 0 ? (
              <div className="hint">No EOD sessions this month.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Date</th><th>Start</th><th>End</th><th className="num">Span</th></tr></thead>
                <tbody>
                  {d.eodSessions.map((s, i) => (
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
        </div>
  );
}
