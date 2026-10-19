import { useResource } from "@/lib/use-resource";
import type { WorkCalendar } from "@/lib/work-calendar";
import type { AttSettings } from "@/lib/use-attendance";

// The organisation's own settings (Settings › General): its name, which day a
// week starts on, and the work calendar. canSaveSettings is false until the
// database has the change that stores the week start and calendar.
export type Org = {
  name: string;
  weekStart: "mon" | "sun";
  calendar: WorkCalendar;
  calendarSaved: boolean;
  canSaveSettings: boolean;
  // Settings › Attendance (missing before the server has it).
  attendance?: AttSettings;
};

export function useOrg() {
  const { data, refetch } = useResource<{ org: Org }>("/org");
  return { org: data?.org ?? null, refetch };
}
