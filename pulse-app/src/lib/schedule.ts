import { useEffect, useState } from "react";
import { ymd } from "@/lib/task-points";

// Scheduling an approved Social task (server/src/scheduling.js): it goes into
// one shared list for this month's schedulers (anyone with a Schedule goal);
// whoever sets its post date takes it, posts it, and within LINK_AFTER_DAYS
// pastes each platform's link — each link becomes a post on the same SID.

export type SchedStage = "to_schedule" | "scheduled" | "links_due" | "live";
export const LINK_AFTER_DAYS = 2;

export function addDaysYmd(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Where a task stands in scheduling, or null when it isn't in it (as the server says).
export function scheduleStage(
  t: { status: string; schedule_from?: string | null; post_on?: string | null; linked_posts?: number | null },
  today = ymd(new Date()),
): SchedStage | null {
  if (!t.schedule_from || t.status !== "done") return null;
  if ((t.linked_posts ?? 0) > 0) return "live";
  if (!t.post_on) return "to_schedule";
  return today >= t.post_on ? "links_due" : "scheduled";
}

// Two days to paste the links once it's out: due by 11:59 PM (IST) on the post
// date + LINK_AFTER_DAYS. The countdown runs from the moment the date is set.
export const linksDueAt = (postOn: string) => new Date(`${addDaysYmd(postOn, LINK_AFTER_DAYS)}T23:59:59+05:30`);
export const linksDueWords = (postOn: string) => `${dayWords(addDaysYmd(postOn, LINK_AFTER_DAYS))}, 11:59 PM`;
// "2d 5h left" · "5h 20m left" · "12m left"; past it, "3h late"
export function leftWords(ms: number) {
  const m = Math.floor(Math.abs(ms) / 60_000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const t = d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${Math.max(1, mm)}m`;
  return ms >= 0 ? `${t} left` : `${t} late`;
}
// how close it is: "" plenty of time, "soon" under 12 hours, "late" past it
export const leftTone = (ms: number) => (ms < 0 ? "late" : ms < 12 * 3_600_000 ? "soon" : "");
// the time now, ticking every half minute, for the countdowns
export function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

export const STAGE_WORDS: Record<SchedStage, string> = {
  to_schedule: "To schedule", scheduled: "Scheduled", links_due: "Waiting for links", live: "Live",
};

// "2026-10-28" → "28 Oct"; "18:30" → "6:30 PM"
export const dayWords = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
export const clockWords = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};

// GET /tasks/:id/schedule
export type TaskSchedule = {
  ready: boolean;
  inFlow?: boolean;
  stage?: SchedStage | null;
  // who took it (null: still in the shared list), and whether that's you
  schedulerId?: string | null; schedulerName?: string | null; mine?: boolean;
  // for a Manager or Team Lead handing it on: this month's schedulers
  schedulers?: { id: string; name: string }[];
  postOn?: string | null; postTime?: string | null; linksDueOn?: string | null;
  // the links' deadline, and whether it passed with none in
  linksDueAt?: string | null; linksLate?: boolean;
  canSchedule?: boolean; canChangeScheduler?: boolean;
  platforms?: { platformId: string; key: string; name: string }[];
  posts?: { id: string; platformId: string; platformKey: string | null; platformName: string | null; permalink: string | null; date: string; views: number; saves: number; metricsUpdatedAt: string | null }[];
  defaults?: { pillarId: string; contentTypeId: string; formatId: string; avatarId: string } | null;
};
