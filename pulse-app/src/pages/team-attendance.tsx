import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Avatar } from "@/lib/editor-visuals";
import { clockTime } from "@/lib/time-format";
import { attendanceAction, type AttSettings, type ShownStatus } from "@/lib/use-attendance";
import { useOrg } from "@/lib/use-org";
import type { Editor } from "@/lib/types";
import "./team-attendance.css";

// Team › Attendance (Pulse Redesign v7): one row per person, one square per
// day of the month in its status colour, then the month's totals — for managers,
// team leads and admins. With `self` (My profile, the top bar's Attendance for
// team members): your own month as a calendar instead (MyMonth). Data:
// GET /attendance/month.

type Cell = {
  status: ShownStatus | null;
  row: {
    checkInAt: string | null; lateMinutes: number; excused: boolean; reason: string | null;
  } | null;
};
type Row = {
  editorId: string; name: string; imageUrl: string | null; designation: string | null; cells: Cell[];
  totals: { late: number; absent: number; leave: number; leaveBy?: { CL: number; SL: number; unpaid: number }; onTimePct: number | null; ptsLost: number };
};
type Month = {
  month: string; scope: "all" | "team" | "self"; settings: AttSettings;
  // a manager marks leave (CL / SL from the person's balance)
  canMarkLeave?: boolean;
  days: { date: string; weekday: number; working: boolean; future: boolean; today: boolean }[];
  rows: Row[];
  footer: { absences: number; capacityLostMinutes: number; latePts: number; absentPts: number };
};

const LABEL: Record<ShownStatus, string> = {
  on_time: "On time", late: "Late", no_sod: "No SOD", waiting: "Not in yet", absent: "Absent", leave: "On leave", half_day: "Half day",
  half_absent: "Half day absent", permission: "Permission",
};
const LEGEND: [string, string][] = [["On time", "on_time"], ["Permission", "permission"], ["Late", "late"], ["Half day absent", "half_absent"], ["Absent", "absent"], ["Leave", "leave"], ["No SOD", "no_sod"]];
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shift = (m: string, by: number) => { const [y, mo] = m.split("-").map(Number); return monthOf(new Date(y, mo - 1 + by, 1)); };
const fmtHM = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

export function TeamAttendance({ editors, self = false }: { editors: Editor[] | null; self?: boolean }) {
  return self ? <MyMonth /> : <TeamMonth editors={editors} />;
}

function TeamMonth({ editors }: { editors: Editor[] | null }) {
  const [month, setMonth] = useState(monthOf());
  const [data, setData] = useState<Month | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancel = false;
    setData(null); setErr(null);
    api<Month>(`/attendance/month?month=${month}`)
      .then((d) => { if (!cancel) setData(d); })
      .catch((e) => { if (!cancel) setErr(e instanceof ApiError ? e.message : "Couldn't load attendance."); });
    return () => { cancel = true; };
  }, [month, reload]);

  const [y, mo] = month.split("-").map(Number);
  const monthName = new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const isThisMonth = month === monthOf();
  const todayN = new Date().getDate();
  const shortMon = new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "short" });
  const sub = isThisMonth ? `1–${todayN} ${shortMon} · hover a day for details · today outlined` : `${shortMon} ${y} · hover a day for details`;

  return (
    <section className="ta" aria-label="Attendance">
      <header className="ta-head">
        <div className="ta-title">
          <span className="ta-nav">
            <button type="button" onClick={() => setMonth(shift(month, -1))} aria-label="Previous month">‹</button>
            <b>{monthName}</b>
            <button type="button" onClick={() => setMonth(shift(month, 1))} disabled={isThisMonth} aria-label="Next month">›</button>
          </span>
          <span>{sub}</span>
        </div>
        <span className="ta-grow" />
        <span className="ta-legend">
          {LEGEND.map(([l, k]) => <span key={k}><i className={"c-" + k} />{l}</span>)}
        </span>
      </header>
      {data?.canMarkLeave && data.rows.length > 0 && (
        <PlanLeave people={data.rows} onSaved={() => setReload((n) => n + 1)} />
      )}
      {err ? <div className="ta-empty">{err}</div> : !data ? <div className="ta-empty">Loading…</div> : data.rows.length === 0 ? (
        <div className="ta-empty">No one checks in yet.</div>
      ) : (
        <>
          <div className="ta-scroll">
            <div className="ta-grid" style={{ gridTemplateColumns: `minmax(150px, 180px) repeat(${data.days.length}, minmax(18px, 1fr)) repeat(5, 58px)` }}>
              <span className="ta-h ta-member">Member</span>
              {data.days.map((d) => (
                <span key={d.date} className={"ta-h ta-day" + (d.today ? " today" : !d.working || d.future ? " off" : "")}>
                  <em>{WD[d.weekday]}</em><b>{Number(d.date.slice(8))}</b>
                </span>
              ))}
              {["Late", "Absent", "Leave", "On time", "Pts lost"].map((h) => <span key={h} className="ta-h ta-num">{h}</span>)}
              {data.rows.map((r) => {
                const ed = editors?.find((e) => e.id === r.editorId) ?? null;
                const t = r.totals;
                return (
                  <div key={r.editorId} className="ta-row" role="row">
                    <span className="ta-who">
                      <span className="ta-ava"><Avatar editor={ed ?? ({ id: r.editorId, name: r.name, designation: r.designation ?? "", image_url: r.imageUrl, active: true } as Editor)} /></span>
                      <b>{r.name}</b>
                    </span>
                    {r.cells.map((c, i) => {
                      const d = data.days[i];
                      const day = `${Number(d.date.slice(8))} ${shortMon}`;
                      const off = !d.working ? (d.weekday === 0 ? "Sunday" : "Office closed") : d.future ? "upcoming" : null;
                      const tip = off ? `${day} · ${off}`
                        : c.status ? `${day} · ${c.row?.excused ? "On time (late excused)" : LABEL[c.status]}${c.row?.checkInAt ? ` · in ${clockTime(c.row.checkInAt)}` : ""}${c.status === "late" && c.row?.lateMinutes ? ` · +${c.row.lateMinutes}m` : ""}${c.row?.reason ? ` · ${c.row.reason}` : ""}`
                        : `${day} · no record`;
                      return <span key={d.date} className={"ta-cell" + (c.status ? " c-" + c.status : "") + (off ? " off" : "") + (d.today ? " today" : "")} title={tip} />;
                    })}
                    <b className={"ta-num" + (t.late >= 3 ? " warn" : "")}>{t.late}</b>
                    <b className={"ta-num" + (t.absent > 0 ? " bad" : "")}>{t.absent}</b>
                    <b className="ta-num" title={t.leaveBy && t.leave ? `CL ${t.leaveBy.CL} · SL ${t.leaveBy.SL} · unpaid ${t.leaveBy.unpaid}` : undefined}>{t.leave}</b>
                    <b className={"ta-num " + (t.onTimePct == null ? "" : t.onTimePct >= 90 ? "good" : t.onTimePct >= 75 ? "warn" : "bad")}>{t.onTimePct == null ? "–" : `${t.onTimePct}%`}</b>
                    <b className={"ta-num" + (t.ptsLost > 0 ? " bad" : " faint")}>{t.ptsLost > 0 ? `−${t.ptsLost}` : "0"}</b>
                  </div>
                );
              })}
            </div>
          </div>
          <footer className="ta-foot">
            {data.footer.absences} unplanned absence{data.footer.absences === 1 ? "" : "s"} this month
            {data.settings.deductCapacity ? ` · ${fmtHM(data.footer.capacityLostMinutes)} of capacity lost` : ""}
            {` · late −${data.footer.latePts} pt, absent −${data.footer.absentPts} pts each`}
          </footer>
        </>
      )}
      {data?.canMarkLeave && (
        <div className="ta-leave-note">Leave balances, approvals and allowances are on the <Link to="/my-team?tab=leave">Leave</Link> tab.</div>
      )}
    </section>
  );
}

// Your own month, as a calendar: each day's status in its colour, with the
// check-in time, how late, or which leave; the month's counts above. No points
// (those are for leads).
const MY_LABEL: Record<ShownStatus, string> = { ...LABEL, half_absent: "Half day absent", leave: "On leave", half_day: "Half day" };
const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function MyMonth() {
  const { org } = useOrg();
  const [month, setMonth] = useState(monthOf());
  const [data, setData] = useState<Month | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancel = false;
    setErr(null);
    api<Month>(`/attendance/month?month=${month}&self=1`)
      .then((d) => { if (!cancel) setData(d); })
      .catch((e) => { if (!cancel) setErr(e instanceof ApiError ? e.message : "Couldn't load attendance."); });
    return () => { cancel = true; };
  }, [month, reload]);
  useEffect(() => {
    const on = () => setReload((n) => n + 1);
    window.addEventListener("pulse:attendance-changed", on);
    return () => window.removeEventListener("pulse:attendance-changed", on);
  }, []);
  const [y, mo] = month.split("-").map(Number);
  const monthName = new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const isThisMonth = month === monthOf();
  const sunFirst = org?.weekStart === "sun";
  const row = data && data.month === month ? data.rows[0] ?? null : null;
  const days = row ? data!.days : [];
  const lead = days.length ? (sunFirst ? days[0].weekday : (days[0].weekday + 6) % 7) : 0;
  const week = sunFirst ? WEEK : [...WEEK.slice(1), WEEK[0]];
  const t = row?.totals;
  const permissions = row ? row.cells.filter((c) => c.status === "permission").length : 0;
  const stat = (v: string, l: string, tone = "", sub = "") => (
    <div className={"my-stat " + tone}><b>{v}</b><span>{l}</span>{sub && <em>{sub}</em>}</div>
  );
  return (
    <section className="ta my" aria-label="My attendance">
      <header className="ta-head">
        <div className="ta-title">
          <span className="ta-nav">
            <button type="button" onClick={() => setMonth(shift(month, -1))} aria-label="Previous month">‹</button>
            <b>{monthName}</b>
            <button type="button" onClick={() => setMonth(shift(month, 1))} disabled={isThisMonth} aria-label="Next month">›</button>
          </span>
          <span>Your days{isThisMonth ? " so far" : ""} · today outlined</span>
        </div>
        <span className="ta-grow" />
        <span className="ta-legend">
          {LEGEND.map(([l, k]) => <span key={k}><i className={"c-" + k} />{l}</span>)}
        </span>
      </header>
      {err ? <div className="ta-empty">{err}</div> : !row || !t ? <div className="ta-empty">{data && data.month === month ? "Your attendance shows here once you start your days." : "Loading…"}</div> : (
        <>
          <div className="my-stats">
            {stat(t.onTimePct == null ? "–" : `${t.onTimePct}%`, "On time", t.onTimePct == null ? "" : t.onTimePct >= 90 ? "good" : t.onTimePct >= 75 ? "warn" : "bad")}
            {stat(String(t.late), t.late === 1 ? "Late day" : "Late days", t.late ? "warn" : "")}
            {stat(String(t.absent), "Absent", t.absent ? "bad" : "")}
            {stat(String(t.leave), "On leave", t.leave ? "rev" : "", t.leaveBy && t.leave ? [t.leaveBy.CL ? `CL ${t.leaveBy.CL}` : "", t.leaveBy.SL ? `SL ${t.leaveBy.SL}` : "", t.leaveBy.unpaid ? `unpaid ${t.leaveBy.unpaid}` : ""].filter(Boolean).join(" · ") : "")}
            {stat(String(permissions), permissions === 1 ? "Permission" : "Permissions")}
          </div>
          <div className="my-cal" role="grid" aria-label={monthName}>
            {week.map((w) => <span key={w} className="my-wd" role="columnheader">{w}</span>)}
            {Array.from({ length: lead }, (_, i) => <span key={"b" + i} className="my-blank" />)}
            {days.map((d, i) => {
              const c = row.cells[i];
              const n = Number(d.date.slice(8));
              const off = !d.working;
              const excused = c.status === "late" && c.row?.excused;
              const label = off ? "Off" : d.future ? "" : !c.status ? "No record" : excused ? "On time" : MY_LABEL[c.status];
              const leaveKind = c.row?.reason === "CL" || c.row?.reason === "SL" ? c.row.reason : c.row?.reason === "unpaid" ? "Unpaid" : null;
              const sub = off || d.future || !c.status ? ""
                : c.status === "leave" || c.status === "half_day" ? leaveKind ?? (c.row?.reason || "")
                : c.status === "late" && !excused ? `+${c.row?.lateMinutes ?? 0}m · ${c.row?.checkInAt ? clockTime(c.row.checkInAt) : ""}`
                : c.row?.checkInAt ? `In ${clockTime(c.row.checkInAt)}` : "";
              const cls = excused ? "on_time" : c.status;
              return (
                <div key={d.date} role="gridcell"
                  className={"my-day" + (!off && !d.future && cls ? " c-" + cls : "") + (off ? " off" : "") + (d.future ? " future" : "") + (d.today ? " today" : "")}
                  title={[`${n} ${monthName}`, label, sub].filter(Boolean).join(" · ")}>
                  <b>{n}</b>
                  {label && <span className="my-st">{label}</span>}
                  {sub && <span className="my-sub">{sub}</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

// Leave planned ahead, or a day put right afterwards: a lead marks leave or a
// half day for one working day, from last month to three months ahead (the
// server checks the day and who may mark whom).
function PlanLeave({ people, onSaved }: { people: Row[]; onSaved: () => void }) {
  const [who, setWho] = useState("");
  const [day, setDay] = useState("");
  const [kind, setKind] = useState<"leave" | "half_day" | "remove">("leave");
  const [type, setType] = useState<"CL" | "SL">("CL");
  const [half, setHalf] = useState<"first" | "second">("first");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const name = people.find((p) => p.editorId === who)?.name ?? "They";
      const when = new Date(`${day}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
      if (kind === "remove") {
        await attendanceAction(who, "undo", { date: day });
        toast.success(`${name}: leave on ${when} taken off`);
      } else {
        await attendanceAction(who, "mark", { as: kind, type, date: day, ...(kind === "half_day" ? { half } : {}) });
        toast.success(`${name}: ${type}, ${kind === "leave" ? "on leave" : `half-day leave (${half} half)`} on ${when}`);
      }
      setDay("");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't mark that day.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ta-plan" role="group" aria-label="Mark leave for a day">
      <b>Leave for a day</b>
      <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
        <option value="">Person…</option>
        {people.map((p) => <option key={p.editorId} value={p.editorId}>{p.name}</option>)}
      </select>
      <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
      <select value={kind} onChange={(e) => setKind(e.target.value as "leave" | "half_day" | "remove")} aria-label="Leave, half day, or take it off">
        <option value="leave">On leave</option>
        <option value="half_day">Half-day leave</option>
        <option value="remove">Take leave off</option>
      </select>
      {kind !== "remove" && (
        <select value={type} onChange={(e) => setType(e.target.value as "CL" | "SL")} aria-label="CL or SL">
          <option value="CL">CL (casual)</option>
          <option value="SL">SL (sick)</option>
        </select>
      )}
      {kind === "half_day" && (
        <select value={half} onChange={(e) => setHalf(e.target.value as "first" | "second")} aria-label="Which half">
          <option value="first">First half</option>
          <option value="second">Second half</option>
        </select>
      )}
      <button type="button" disabled={!who || !day || busy} onClick={save}>{busy ? "Saving…" : kind === "remove" ? "Take off" : "Mark"}</button>
    </div>
  );
}
