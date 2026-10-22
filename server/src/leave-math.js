// Leave maths — CL (casual) and SL (sick). The rules are in "Leave CL-SL
// spec.md"; this follows the prototype's evaluate(), notice(), used() and tot()
// ("Pulse Leave.dc.html"). Pure: dates are 'YYYY-MM-DD' on India time, and
// whether a day is a working day comes in as a function (the work calendar:
// Sundays, Saturdays off and holidays never use leave). leave.js does the
// database side.

export const LEAVE_DEFAULTS = { noticeDays: 2, shortNoticePts: 2, unpaidPts: 3, countingSince: null };
// Days into a new month that last month stays open (Management Performance
// stores — freezes — a month after this); leave can't be approved or
// cancelled in a frozen month.
export const SETTLE_DAYS = 10;
export const MAX_DAYS = 30;
export const SL_BACK_DAYS = 7;
export const HALF_WORDS = { full: "Full day", first: "First half", second: "Second half" };

const DAY_MS = 86_400_000;
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// Working days a..b, both included.
export function workingDates(isWorking, a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) if (isWorking(d)) out.push(d);
  return out;
}
export const workingDays = (isWorking, a, b) => workingDates(isWorking, a, b).length;

// Notice for a CL: working days from today (included) to the day before it
// starts. Thu → Sat = Thu, Fri = 2; Thu → Fri = 1. A leave starting today or
// earlier has none.
export const noticeOf = (isWorking, today, from) => (from <= today ? 0 : workingDays(isWorking, today, addDays(from, -1)));

// Leave days a request uses: half a day for a half (on a working day), else
// the working days in the range.
export function daysOf(isWorking, from, to, half = "full") {
  if (from === to && half !== "full") return isWorking(from) ? 0.5 : 0;
  return workingDays(isWorking, from, to);
}

// A range crossing 31 Dec, split by year (each part against its year's
// allowance).
export function splitByYear(from, to) {
  const parts = [];
  let a = from;
  while (a <= to) {
    const end = `${a.slice(0, 4)}-12-31`;
    const b = to < end ? to : end;
    parts.push([a, b]);
    a = addDays(b, 1);
  }
  return parts;
}

// Is the request itself sound? An error message, or null.
export function checkRequest({ type, from, to, half = "full", today, isWorking }) {
  if (!from || !to) return "Pick the days.";
  if (to < from) return "“To” is before “From”.";
  if (half !== "full" && from !== to) return "A half day is one day.";
  if (type === "CL" && from < today) return "Casual leave can’t be for a past day. If you were ill, choose sick leave.";
  if (type === "SL" && from < addDays(today, -SL_BACK_DAYS)) return "Sick leave can go back 7 days at most. Older days need a manager.";
  if (workingDays(isWorking, from, to) > MAX_DAYS) return "Up to 30 working days in one request.";
  if (!daysOf(isWorking, from, to, half)) return "No working days in that range (Sundays and off days don’t use leave).";
  return null;
}

// The split and the price of a request: paid days from what's left (total −
// what approved and waiting requests already hold), the rest unpaid; CL with
// less notice than the rule is short notice. Points: the short-notice cut once
// per request, plus the unpaid rate a day. `shortApplies` false for the second
// part of a request split at the year's end (its notice was the first part's).
export function priceRequest({ type, days, from, today, isWorking, rules, total, used, shortApplies = true }) {
  const left = Math.max(0, total - used);
  const paid = Math.min(days, left);
  const unpaid = days - paid;
  const notice = type === "CL" ? noticeOf(isWorking, today, from) : null;
  const short = type === "CL" && shortApplies && notice < rules.noticeDays;
  const shortPts = short ? rules.shortNoticePts : 0;
  const unpaidRate = rules.unpaidPts;
  return { days, paid, unpaid, notice, short, shortPts, unpaidRate, pts: shortPts + unpaid * unpaidRate, total, left };
}

// Re-split at approval (another request may have used the balance, or freed
// it): the same days and rates, against what's left now.
export function resplit({ days, total, usedByOthers, shortPts, unpaidRate }) {
  const paid = Math.min(days, Math.max(0, total - usedByOthers));
  const unpaid = days - paid;
  return { paid, unpaid, pts: shortPts + unpaid * unpaidRate };
}

// Has Management Performance frozen this month ('YYYY-MM')? Months before last
// month always; last month once SETTLE_DAYS of this one have gone.
export function monthFrozen(ym, today) {
  const thisMonth = today.slice(0, 7);
  if (ym >= thisMonth) return false;
  const d = new Date(`${thisMonth}-01T00:00:00Z`);
  const lastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return !(ym === lastMonth && Number(today.slice(8, 10)) <= SETTLE_DAYS);
}
// Any month a..b touches frozen?
export function rangeFrozen(from, to, today) {
  for (let m = from.slice(0, 7); m <= to.slice(0, 7);) {
    if (monthFrozen(m, today)) return m;
    const d = new Date(`${m}-01T00:00:00Z`);
    m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  }
  return null;
}

// "Mon 26 Oct" and "Mon 26 – Wed 28 Oct" style words.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayWords(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
export const n1 = (x) => String(Math.round(Number(x) * 10) / 10);
export function requestWords(r) {
  const dates = r.from === r.to ? dayWords(r.from) : `${dayWords(r.from)} – ${dayWords(r.to)}`;
  const size = r.half && r.half !== "full" ? HALF_WORDS[r.half].toLowerCase() : `${n1(r.days)} day${Number(r.days) === 1 ? "" : "s"}`;
  return `${r.type} · ${dates} (${size})`;
}
