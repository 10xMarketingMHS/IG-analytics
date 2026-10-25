// Shared by the Activity page and the bell's box.
import type { ActivityVerb } from "@/lib/types";

// Icon + tone per event kind, so the feed reads at a glance.
export const VERB_META: Record<ActivityVerb, { icon: string; cls: string }> = {
  created: { icon: "✅", cls: "v-task" },
  completed: { icon: "🎉", cls: "v-done" },
  assigned: { icon: "👤", cls: "v-task" },
  commented: { icon: "💬", cls: "v-comment" },
  published: { icon: "🚀", cls: "v-post" },
  stage_completed: { icon: "🎬", cls: "v-post" },
  channel_added: { icon: "🌐", cls: "v-channel" },
  editor_added: { icon: "🧑‍🎨", cls: "v-editor" },
  review_requested: { icon: "👀", cls: "v-task" },
  review_copied: { icon: "⏰", cls: "v-task" },
  sent_back: { icon: "↩️", cls: "v-task" },
  reopened: { icon: "🔄", cls: "v-task" },
  deleted: { icon: "🗑️", cls: "v-task" },
  held: { icon: "⏸️", cls: "v-task" },
  resumed: { icon: "▶️", cls: "v-task" },
  password_reset_requested: { icon: "🔑", cls: "v-editor" },
  password_reset: { icon: "🔑", cls: "v-editor" },
  sod_submitted: { icon: "📝", cls: "v-editor" },
  attendance_check_in: { icon: "☀️", cls: "v-editor" },
  attendance_no_sod: { icon: "⏰", cls: "v-editor" },
  attendance_nudge: { icon: "👋", cls: "v-editor" },
  attendance_marked: { icon: "📋", cls: "v-editor" },
  attendance_excused: { icon: "✅", cls: "v-editor" },
  attendance_undone: { icon: "↩️", cls: "v-editor" },
  attendance_correction: { icon: "🕘", cls: "v-editor" },
  attendance_correction_answered: { icon: "🕘", cls: "v-editor" },
  attendance_late_reason: { icon: "💬", cls: "v-editor" },
  accepted: { icon: "👍", cls: "v-task" },
  handover_offered: { icon: "🔁", cls: "v-task" },
  handover_accepted: { icon: "🤝", cls: "v-done" },
  handover_declined: { icon: "↩️", cls: "v-task" },
  handover_cancelled: { icon: "↩️", cls: "v-task" },
  handover_escalated: { icon: "⚠️", cls: "v-task" },
  handover_moved: { icon: "🔁", cls: "v-task" },
  leave_asked: { icon: "🌴", cls: "v-editor" },
  leave_approved: { icon: "🌴", cls: "v-done" },
  leave_declined: { icon: "↩️", cls: "v-editor" },
  leave_cancelled: { icon: "↩️", cls: "v-editor" },
  leave_topped_up: { icon: "➕", cls: "v-done" },
  leave_allowance_set: { icon: "🗓️", cls: "v-editor" },
  leave_counting_started: { icon: "▶️", cls: "v-editor" },
  leave_rules_changed: { icon: "⚙️", cls: "v-editor" },
  attendance_leave_worked: { icon: "💼", cls: "v-editor" },
  schedule_ready: { icon: "🗓️", cls: "v-post" },
  schedule_set: { icon: "📅", cls: "v-post" },
  schedule_linked: { icon: "🚀", cls: "v-post" },
};

export function relTime(iso: string) {
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}
