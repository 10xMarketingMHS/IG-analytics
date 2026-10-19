import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Avatar } from "@/lib/editor-visuals";
import { clockTime } from "@/lib/time-format";
import type { AttSettings, ShownStatus } from "@/lib/use-attendance";
import type { Editor } from "@/lib/types";
import "./team-attendance.css";

// Team › Attendance (Pulse Redesign v7): one row per person, one square per
// day of the month in its status colour, then the month's totals. Managers and
// team leads see everyone; anyone else only their own row (used on My profile
// with `self`). Data: GET /attendance/month.

type Cell = { status: ShownStatus | null; row: { checkInAt: string | null; lateMinutes: number; excused: boolean; reason: string | null } | null };
type Row = {
  editorId: string; name: string; imageUrl: string | null; designation: string | null; cells: Cell[];
  totals: { late: number; absent: number; leave: number; onTimePct: number | null; ptsLost: number };
};
type Month = {
  month: string; scope: "all" | "team" | "self"; settings: AttSettings;
  days: { date: string; weekday: number; working: boolean; future: boolean; today: boolean }[];
  rows: Row[];
  footer: { absences: number; capacityLostMinutes: number; latePts: number; absentPts: number };
};

const LABEL: Record<ShownStatus, string> = {
  on_time: "On time", late: "Late", no_sod: "No SOD", waiting: "Not in yet", absent: "Absent", leave: "On leave", half_day: "Half day",
};
const LEGEND: [string, string][] = [["On time", "on_time"], ["Late", "late"], ["Absent", "absent"], ["Leave", "leave"], ["No SOD", "no_sod"]];
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shift = (m: string, by: number) => { const [y, mo] = m.split("-").map(Number); return monthOf(new Date(y, mo - 1 + by, 1)); };
const fmtHM = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

export function TeamAttendance({ editors, self = false }: { editors: Editor[] | null; self?: boolean }) {
  const [month, setMonth] = useState(monthOf());
  const [data, setData] = useState<Month | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    setData(null); setErr(null);
    api<Month>(`/attendance/month?month=${month}${self ? "&self=1" : ""}`)
      .then((d) => { if (!cancel) setData(d); })
      .catch((e) => { if (!cancel) setErr(e instanceof ApiError ? e.message : "Couldn't load attendance."); });
    return () => { cancel = true; };
  }, [month, self]);

  const [y, mo] = month.split("-").map(Number);
  const monthName = new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const isThisMonth = month === monthOf();
  const todayN = new Date().getDate();
  const shortMon = new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "short" });
  const sub = isThisMonth ? `1–${todayN} ${shortMon} · hover a day for details · today outlined` : `${shortMon} ${y} · hover a day for details`;

  return (
    <section className={"ta" + (self ? " self" : "")} aria-label="Attendance">
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
                    <b className="ta-num">{t.leave}</b>
                    <b className={"ta-num " + (t.onTimePct == null ? "" : t.onTimePct >= 90 ? "good" : t.onTimePct >= 75 ? "warn" : "bad")}>{t.onTimePct == null ? "–" : `${t.onTimePct}%`}</b>
                    <b className={"ta-num" + (t.ptsLost > 0 ? " bad" : " faint")}>{t.ptsLost > 0 ? `−${t.ptsLost}` : "0"}</b>
                  </div>
                );
              })}
            </div>
          </div>
          {!self && (
            <footer className="ta-foot">
              {data.footer.absences} unplanned absence{data.footer.absences === 1 ? "" : "s"} this month
              {data.settings.deductCapacity ? ` · ${fmtHM(data.footer.capacityLostMinutes)} of capacity lost` : ""}
              {` · late −${data.footer.latePts} pt, absent −${data.footer.absentPts} pts each`}
            </footer>
          )}
        </>
      )}
    </section>
  );
}
