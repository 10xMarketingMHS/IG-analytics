// The work calendar (Settings › General) → one month's capacity per editor.
// Mirrors pulse-app/src/lib/work-calendar.ts; keep the two in step.
//
// Working days = the month's weekdays and Saturdays, less the sick-leave
// buffer (taken from weekdays first). Each day's hours = its office hours less
// lunch and tea (Saturdays too, when breaks apply then). Sundays never count.
// The capacity adjustment adds or takes away whole hours for the month.
// Holidays (dates the office is shut) are closed days: they come out of the
// weekdays or Saturdays they fall on, before the sick-leave buffer.

export const CALENDAR_DEFAULTS = {
  wdFrom: "09:00", wdTo: "18:00", satFrom: "09:00", satTo: "16:00",
  satOff: false, satBreaks: true, sickDays: 2, adjustHours: 0, holidays: [],
};
// Lunch and tea — the same 75 minutes as the daily break allowance (breaks.js).
export const LUNCH_MIN = 45;
export const TEA_MIN = 30;

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function normalizeCalendar(c) {
  const out = { ...CALENDAR_DEFAULTS, ...(c && typeof c === "object" ? c : {}) };
  out.holidays = [...new Set((Array.isArray(out.holidays) ? out.holidays : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))].sort();
  return out;
}
// Is this date (YYYY-MM-DD) one of the calendar's holidays?
export function isHoliday(cal, ymd) {
  return normalizeCalendar(cal).holidays.includes(String(ymd).slice(0, 10));
}

// year, monthIndex (0–11) → { workingDays, minutes, weekdays, saturdays, ... }
export function capacityFor(cal, year, monthIndex) {
  const c = normalizeCalendar(cal);
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  let sundays = 0, saturdays = 0, holWeekdays = 0, holSats = 0;
  const hol = new Set(c.holidays);
  for (let d = 1; d <= days; d++) {
    const w = new Date(Date.UTC(year, monthIndex, d)).getUTCDay();
    const ymd = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (w === 0) sundays++;
    else if (w === 6) { saturdays++; if (hol.has(ymd) && !c.satOff) holSats++; }
    else if (hol.has(ymd)) holWeekdays++;
  }
  const brk = LUNCH_MIN + TEA_MIN;
  const wdMin = Math.max(0, minutesOf(c.wdTo) - minutesOf(c.wdFrom) - brk);
  const satMin = c.satOff ? 0 : Math.max(0, minutesOf(c.satTo) - minutesOf(c.satFrom) - (c.satBreaks ? brk : 0));
  const weekdays0 = days - sundays - saturdays - holWeekdays;
  const sick = Math.max(0, Number(c.sickDays) || 0);
  const weekdays = Math.max(0, weekdays0 - sick);
  const sats0 = c.satOff ? 0 : saturdays - holSats;
  const sats = Math.max(0, sats0 - Math.max(0, sick - weekdays0));
  const minutes = Math.max(0, weekdays * wdMin + sats * satMin + (Number(c.adjustHours) || 0) * 60);
  return { days, sundays, satCount: saturdays, saturdays: sats0, weekdays, sats, wdMin, satMin, sick, holidays: holWeekdays + holSats, workingDays: weekdays + sats, minutes };
}
