import type { ContentFormatDef } from "@/lib/types";

// The schedule types: the ones scheduling counts as, each with its own goals,
// points and time — Schedule itself, its sub-types, any type with "schedule" in
// its name (Reels schedule, Story schedule), and any a Social type counts as
// (Settings › Tasks & time › Scheduling). The server holds the same
// (server/src/scheduling.js scheduleTypeIds); a goal on one makes someone a scheduler.
export const isScheduleName = (name: string) => ["schedule", "scheduling"].includes(name.trim().toLowerCase());

export function scheduleTypeIds(formats: ContentFormatDef[]): Set<string> {
  const active = formats.filter((f) => f.active !== false);
  const base = active.find((f) => isScheduleName(f.name));
  const ids = new Set<string>();
  for (const f of active) {
    if (/schedul/i.test(f.name) || (base && f.parent_id === base.id)) ids.add(f.id);
    if (f.schedule_as && active.some((x) => x.id === f.schedule_as)) ids.add(f.schedule_as);
  }
  return ids;
}
