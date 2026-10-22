import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// Leave — CL (casual) and SL (sick) — the app side of server/src/routes/leave.js.
// Each change says attendance changed, so Home, Team today and the Inbox
// re-read.

export type LeaveType = "CL" | "SL";
export type LeaveHalf = "full" | "first" | "second";
export type LeaveStatus = "pending" | "approved" | "declined" | "cancelled";
export type LeaveRequest = {
  id: string; editorId: string; type: LeaveType; from: string; to: string; half: LeaveHalf;
  days: number; paid: number; unpaid: number; notice: number | null; short: boolean; pts: number; shortPts?: number;
  status: LeaveStatus; reason: string | null; createdAt: string; decidedAt: string | null;
  decidedByName?: string | null; name?: string; imageUrl?: string | null;
};
export type TypeBalance = { start: number; topups: number; total: number; taken: number; waiting: number; left: number };
export type LeaveBalance = { CL: TypeBalance; SL: TypeBalance; unpaid: number; unpaidWaiting: number; pts: number };
export type LeaveRules = { noticeDays: number; shortNoticePts: number; unpaidPts: number };
export type LeaveMine = {
  ready: boolean; linked?: boolean; year: number; today: string; rules: LeaveRules; counting: boolean; countingSince: string | null;
  canApprove: boolean; name?: string | null; balance: LeaveBalance | null; requests: LeaveRequest[];
};
export type LeavePerson = { id: string; name: string; designation: string | null; imageUrl: string | null; balance?: LeaveBalance };
export type LeaveGrant = { id: string; editorId: string; type: LeaveType; days: number; note: string; at: string; name: string; byName: string | null };
export type LeaveTeam = {
  year: number; today: string; rules: LeaveRules; counting: boolean; countingSince: string | null; me: string | null;
  canEditRules: boolean; canEditStart: boolean;
  people: LeavePerson[]; pending: LeaveRequest[]; decided: LeaveRequest[]; grants: LeaveGrant[];
};
export type LeavePreview = { error: string } | {
  error?: undefined; days: number; paid: number; unpaid: number; notice: number | null; short: boolean; pts: number; total: number; left: number;
};

const changed = () => window.dispatchEvent(new Event("pulse:attendance-changed"));
const post = <T = unknown>(path: string, body?: object, method = "POST") =>
  api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });

export async function askLeave(body: { type: LeaveType; from: string; to: string; half: LeaveHalf; reason?: string }) {
  const d = await post<{ requests: LeaveRequest[] }>("/leave", body);
  changed();
  return d.requests;
}
export const previewLeave = (body: { type: LeaveType; from: string; to: string; half: LeaveHalf }) => post<LeavePreview>("/leave/preview", body);
export async function decideLeave(id: string, approve: boolean) {
  const d = await post<{ request: LeaveRequest }>(`/leave/${id}/decide`, { approve });
  changed();
  return d.request;
}
export async function cancelLeave(id: string) {
  const d = await post<{ request: LeaveRequest }>(`/leave/${id}/cancel`);
  changed();
  return d.request;
}
export async function setAllowance(editorId: string, year: number, cl: number, sl: number) {
  await post(`/leave/allowance/${editorId}`, { year, cl, sl }, "PUT");
  changed();
}
export async function startCounting() {
  await post("/leave/start-counting");
  changed();
}
export async function topUp(body: { editorId: string; type: LeaveType; days: number; note: string; year: number }) {
  await post("/leave/grant", body);
  changed();
}
export async function saveLeaveRules(rules: LeaveRules) {
  await post("/leave/rules", rules, "PUT");
  changed();
}

// Read one of the leave answers, again whenever attendance changes.
export function useLeaveData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load leave.");
    }
  }, [path]);
  useEffect(() => {
    load();
    const on = () => { load(); };
    window.addEventListener("pulse:attendance-changed", on);
    return () => window.removeEventListener("pulse:attendance-changed", on);
  }, [load]);
  return { data, error, reload: load };
}

// "Thu 22 Oct" style, and a range.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
export const fmtDates = (r: Pick<LeaveRequest, "from" | "to">) => (r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`);
export const n1 = (x: number) => String(Math.round(x * 10) / 10);
export const dayWord = (x: number) => `${n1(x)} day${x === 1 ? "" : "s"}`;
export const HALF_WORDS: Record<LeaveHalf, string> = { full: "Full day", first: "First half", second: "Second half" };
export const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// "1 day · 1 day unpaid · short notice · −5 pts" (the prototype's detailOf)
export function detailOf(r: LeaveRequest, showPts = true) {
  const bits = [r.half !== "full" ? HALF_WORDS[r.half] : dayWord(r.days)];
  if (r.unpaid) bits.push(`${dayWord(r.unpaid)} unpaid`);
  if (r.short) bits.push("short notice");
  if (showPts && r.pts) bits.push(`−${n1(r.pts)} pts`);
  return bits.join(" · ");
}
