// The work calendar (Settings › General) → one month's capacity per editor.
// Mirrors server/src/work-calendar.js; keep the two in step.
//
// Working days = the month's weekdays and Saturdays, less the sick-leave
// buffer (taken from weekdays first). Each day's hours = its office hours less
// lunch and tea (Saturdays too, when breaks apply then). Sundays never count.
// The capacity adjustment adds or takes away whole hours for the month.
// Holidays (dates the office is shut) are closed days: they come out of the
// weekdays or Saturdays they fall on, before the sick-leave buffer.

export type WorkCalendar = {
  wdFrom: string; wdTo: string; satFrom: string; satTo: string;
  satOff: boolean; satBreaks: boolean; sickDays: number; adjustHours: number;
  holidays?: string[]; // YYYY-MM-DD
};
export const CALENDAR_DEFAULTS: WorkCalendar = {
  wdFrom: "09:00", wdTo: "18:00", satFrom: "09:00", satTo: "16:00",
  satOff: false, satBreaks: true, sickDays: 2, adjustHours: 0, holidays: [],
};
// Lunch and tea — the same 75 minutes as the daily break allowance.
export const LUNCH_MIN = 45;
export const TEA_MIN = 30;

export const minutesOf = (hhmm: string) => {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function capacityFor(cal: WorkCalendar, year: number, monthIndex: number) {
  const days = new Date(year, monthIndex + 1, 0).getDate();
  let sundays = 0, saturdays = 0, holWeekdays = 0, holSats = 0;
  const hol = new Set(cal.holidays ?? []);
  for (let d = 1; d <= days; d++) {
    const w = new Date(year, monthIndex, d).getDay();
    const ymd = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (w === 0) sundays++;
    else if (w === 6) { saturdays++; if (hol.has(ymd) && !cal.satOff) holSats++; }
    else if (hol.has(ymd)) holWeekdays++;
  }
  const brk = LUNCH_MIN + TEA_MIN;
  const wdMin = Math.max(0, minutesOf(cal.wdTo) - minutesOf(cal.wdFrom) - brk);
  const satMin = cal.satOff ? 0 : Math.max(0, minutesOf(cal.satTo) - minutesOf(cal.satFrom) - (cal.satBreaks ? brk : 0));
  const weekdays0 = days - sundays - saturdays - holWeekdays;
  const sick = Math.max(0, cal.sickDays || 0);
  const weekdays = Math.max(0, weekdays0 - sick);
  const sats0 = cal.satOff ? 0 : saturdays - holSats;
  const sats = Math.max(0, sats0 - Math.max(0, sick - weekdays0));
  const minutes = Math.max(0, weekdays * wdMin + sats * satMin + (cal.adjustHours || 0) * 60);
  return { days, sundays, satCount: saturdays, saturdays: sats0, weekdays, sats, wdMin, satMin, sick, holidays: holWeekdays + holSats, workingDays: weekdays + sats, minutes };
}

// The stored capacity for a month: whole working days × hours a day (to four
// decimals, so the month stays right to the minute), which is what Goals reads.
export function storedCapacity(cal: WorkCalendar, year: number, monthIndex: number) {
  const c = capacityFor(cal, year, monthIndex);
  return { workingDays: c.workingDays, hoursPerDay: c.workingDays ? Math.round((c.minutes / 60 / c.workingDays) * 10000) / 10000 : 0 };
}

// Inside office hours right now? Sundays (and Saturdays when off) never are.
export function isWorkingNow(cal: WorkCalendar, now = new Date()) {
  const w = now.getDay();
  if (w === 0 || (w === 6 && cal.satOff)) return false;
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if ((cal.holidays ?? []).includes(ymd)) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const [from, to] = w === 6 ? [cal.satFrom, cal.satTo] : [cal.wdFrom, cal.wdTo];
  return m >= minutesOf(from) && m < minutesOf(to);
}
