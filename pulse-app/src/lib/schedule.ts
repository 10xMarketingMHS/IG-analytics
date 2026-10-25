import { ymd } from "@/lib/task-points";

// Scheduling an approved Social task (server/src/scheduling.js): the brand's
// scheduler sets the post date, posts it, and LINK_AFTER_DAYS later pastes each
// platform's link — each link becomes a post on the same SID.

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
  return today >= addDaysYmd(t.post_on, LINK_AFTER_DAYS) ? "links_due" : "scheduled";
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
  schedulerId?: string | null; schedulerName?: string | null;
  brandSchedulerId?: string | null; brandSchedulerName?: string | null;
  postOn?: string | null; postTime?: string | null; linksDueOn?: string | null;
  canSchedule?: boolean; canChangeScheduler?: boolean;
  platforms?: { platformId: string; key: string; name: string }[];
  posts?: { id: string; platformId: string; platformKey: string | null; platformName: string | null; permalink: string | null; date: string; views: number; saves: number; metricsUpdatedAt: string | null }[];
  defaults?: { pillarId: string; contentTypeId: string; formatId: string; avatarId: string } | null;
};
