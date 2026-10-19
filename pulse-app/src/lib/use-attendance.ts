import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { HomeRole } from "@/lib/home-role";

// Attendance (server/src/routes/attendance.js): your own day, for the Start
// day card, and — for team leads and managers — your people's, for the Team
// today widget. Re-reads every minute and whenever the day changes.

export type AttStatus = "on_time" | "late" | "no_sod" | "absent" | "leave" | "half_day";
export type AttRow = {
  id: string; editorId: string; date: string;
  checkInAt: string | null; checkOutAt: string | null;
  planNote: string | null; eodNote: string | null;
  status: AttStatus; lateMinutes: number; excused: boolean;
  markedBy: string | null; autoMarked: boolean; reason: string | null;
  alertSentAt: string | null; nudgedAt: string | null;
  correctionAt: string | null; correctionNote: string | null; correctionStatus: "pending" | "approved" | "declined" | null;
};
export type AttSettings = {
  requireSod: boolean; graceMinutes: number; noSodAlertAt: string; autoAbsentAt: string; autoAbsentEnabled: boolean;
  requireEodNote: boolean; allowCorrections: boolean; latePenaltyPts: number; absentPenaltyPts: number; deductCapacity: boolean;
  // Who besides admins sees the whole team's attendance, by position.
  teamView?: TeamView;
};
export type TeamView = { manager: boolean; asstManager: boolean; teamLead: boolean };
// What a person shows as in Team today ("waiting" = not in yet).
export type ShownStatus = AttStatus | "waiting";
export type TeamPerson = {
  editorId: string; name: string; imageUrl: string | null; designation: string | null;
  status: ShownStatus; row: AttRow | null; penalty: number;
};
export type AttToday = {
  date: string; now: string; opening: string | null; closing: string | null;
  settings: AttSettings; role: HomeRole; scope: "all" | "self";
  checksIn: boolean; me: AttRow | null; team: TeamPerson[] | null;
};

export function useAttendanceToday(enabled = true) {
  const [data, setData] = useState<AttToday | null>(null);
  const [missing, setMissing] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await api<AttToday>("/attendance/today"));
      setMissing(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setMissing(true);
    }
  }, []);
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
export async function attendanceAction(editorId: string, action: "excuse" | "undo" | "nudge" | "mark" | "correction", body?: object) {
  const d = await api<{ attendance: AttRow | null }>(`/attendance/${editorId}/${action}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  window.dispatchEvent(new Event("pulse:attendance-changed"));
  return d;
}

// "9:00" → minutes after midnight.
export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
