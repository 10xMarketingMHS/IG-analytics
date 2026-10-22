import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { HomeRole } from "@/lib/home-role";

// Attendance (server/src/routes/attendance.js): your own day, for the Start
// day card, and — for team leads and managers — your people's, for the Team
// today widget. Re-reads every minute and whenever the day changes.

// half_absent: not in by the half-day time (half the absence penalty).
export type AttStatus = "on_time" | "late" | "no_sod" | "absent" | "leave" | "half_day" | "half_absent";
export type AttRow = {
  id: string; editorId: string; date: string;
  checkInAt: string | null; checkOutAt: string | null;
  planNote: string | null; eodNote: string | null;
  status: AttStatus; lateMinutes: number; excused: boolean;
  markedBy: string | null; autoMarked: boolean; reason: string | null;
  alertSentAt: string | null; nudgedAt: string | null;
  correctionAt: string | null; correctionNote: string | null; correctionStatus: "pending" | "approved" | "declined" | null;
  // a day of approved leave: which leave, CL or SL, and whether it was short notice
  leaveId?: string | null; leaveKind?: LeaveKind | null; shortNotice?: boolean;
};
export type AttSettings = {
  requireSod: boolean; graceMinutes: number; noSodAlertAt: string; autoAbsentAt: string; autoAbsentEnabled: boolean;
  // not in by halfDayAt: half-day absent; still not in by autoAbsentAt: absent
  halfDayAt?: string;
  // permissions a month (morning: come in late; evening: leave early)
  permissionsPerMonth?: number;
  // CL applied for fewer days ahead is short notice
  clNoticeDays?: number;
  requireEodNote: boolean; allowCorrections: boolean; latePenaltyPts: number; absentPenaltyPts: number; deductCapacity: boolean;
  // Who besides admins sees the whole team's attendance, by position.
  teamView?: TeamView;
};
export type TeamView = { manager: boolean; asstManager: boolean; teamLead: boolean };
// What a person shows as in Team today ("waiting" = not in yet; "permission" =
// came in late with a morning permission).
export type ShownStatus = AttStatus | "waiting" | "permission";
// A permission (server/src/attendance.js): asked ahead, approved, or used.
export type Permission = { id: string; date: string; part: "morning" | "evening"; status: "requested" | "approved" | "declined" | "used"; emergency: boolean; note: string | null };
export type PermissionRequest = { id: string; editorId: string; date: string; part: "morning" | "evening"; note: string | null };
export type TeamPerson = {
  editorId: string; name: string; imageUrl: string | null; designation: string | null;
  status: ShownStatus; row: AttRow | null; penalty: number;
  // permission requests waiting for a lead
  permissionRequests?: PermissionRequest[];
  // leave waiting for a lead
  leaveRequests?: Leave[];
};
export type AttToday = {
  date: string; now: string; opening: string | null; closing: string | null;
  settings: AttSettings; role: HomeRole; scope: "all" | "self";
  checksIn: boolean; me: AttRow | null; team: TeamPerson[] | null;
  // yours this month (null before the database has permissions)
  permissions?: { perMonth: number; left: number; mine: Permission[] } | null;
  // yours this year (null before the database has leave)
  leave?: MyLeave | null;
};

// Leave (server/src/leave.js): CL, casual leave — each person has their own
// number a calendar year, applied for ahead (short notice otherwise), unpaid
// past the year's number — and SL, sick leave, any time, no limit.
export type LeaveKind = "cl" | "sl";
export type Leave = {
  id: string; editorId: string; kind: LeaveKind; dates: string[]; half: boolean; shortNotice: boolean;
  status: "requested" | "approved" | "declined" | "cancelled"; note: string | null;
};
// perYear: null when no number was set (counts as 0)
export type LeaveYear = { perYear: number | null; cl: number; unpaid: number; sl: number; waitingCl: number; waitingSl: number };
export type MyLeave = LeaveYear & { year: number; noticeDays: number; mine: Leave[] };

// The last answer is kept for this tab (today only), so Home shows your day
// at once and refreshes it in the background instead of waiting on the server.
const CACHE_KEY = "pulse-att-today";
const localYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function readCache(who: string): AttToday | null {
  try {
    const c = JSON.parse(window.sessionStorage.getItem(`${CACHE_KEY}:${who}`) || "null") as AttToday | null;
    return c && c.date === localYmd() ? c : null;
  } catch { return null; }
}

// `who`: the signed-in user's id, so a different login never sees another's day.
export function useAttendanceToday(enabled = true, who = "") {
  const [data, setData] = useState<AttToday | null>(() => (who ? readCache(who) : null));
  const [missing, setMissing] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const d = await api<AttToday>("/attendance/today");
      setData(d);
      if (who) { try { window.sessionStorage.setItem(`${CACHE_KEY}:${who}`, JSON.stringify(d)); } catch { /* not kept, still shown */ } }
      setMissing(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setMissing(true);
    }
  }, [who]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, 60_000);
    const on = () => refresh();
    window.addEventListener("pulse:attendance-changed", on);
    window.addEventListener("pulse:workday-changed", on);
    return () => {
      clearInterval(id);
      window.removeEventListener("pulse:attendance-changed", on);
      window.removeEventListener("pulse:workday-changed", on);
    };
  }, [enabled, refresh]);
  return { data, missing, refresh };
}

// A lead's or manager's action on one person's day; says the day changed.
export async function attendanceAction(editorId: string, action: "excuse" | "undo" | "nudge" | "mark" | "correction" | "permission", body?: object) {
  const d = await api<{ attendance: AttRow | null }>(`/attendance/${editorId}/${action}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  window.dispatchEvent(new Event("pulse:attendance-changed"));
  return d;
}

// "9:00" → minutes after midnight.
export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

// Apply for leave; your lead approves it.
export async function applyLeave(body: { kind: LeaveKind; from: string; to?: string; half?: boolean; note?: string }) {
  const d = await api<{ leave: Leave }>("/attendance/leave", { method: "POST", body: JSON.stringify(body) });
  window.dispatchEvent(new Event("pulse:attendance-changed"));
  return d.leave;
}
// Take back your own leave (still waiting, or approved and not started).
export async function cancelMyLeave(id: string) {
  await api(`/attendance/leave/${id}/cancel`, { method: "POST" });
  window.dispatchEvent(new Event("pulse:attendance-changed"));
}
// A lead's answer to a leave request, or taking a leave back.
export async function leaveAction(editorId: string, id: string, action: "approve" | "decline" | "cancel") {
  await api(`/attendance/${editorId}/leave/${id}`, { method: "POST", body: JSON.stringify({ action }) });
  window.dispatchEvent(new Event("pulse:attendance-changed"));
}
// "CL · 24 Oct" or "SL · 24 – 26 Oct (3 days)", "· half day".
export function leaveWords(l: Pick<Leave, "kind" | "dates" | "half">) {
  const f = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const n = l.dates.length;
  const span = n === 1 ? f(l.dates[0]) : `${f(l.dates[0])} – ${f(l.dates[n - 1])} (${n} days)`;
  return `${l.kind === "cl" ? "CL" : "SL"} · ${span}${l.half ? " · half day" : ""}`;
}

// Ask ahead for a morning (come in late) or evening (leave early) permission.
export async function askPermission(date: string, part: "morning" | "evening", note?: string) {
  const d = await api<{ permissions: Permission[] }>("/attendance/permission", { method: "POST", body: JSON.stringify({ date, part, note }) });
  window.dispatchEvent(new Event("pulse:attendance-changed"));
  return d;
}
