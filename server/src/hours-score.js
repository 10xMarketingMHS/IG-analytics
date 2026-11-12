// Media House Leaders' score (routes/leaderboard.js): the same working time for
// everyone is the yardstick, so the size of someone's goal doesn't decide their
// place.
//
//  Hours filled = the hours their finished work is worth ÷ the working hours so
//    far this month (its working days × hours a day, less approved leave).
//    Each finished job is worth its type's set time (Settings › Tasks & time),
//    by the kind of work it was, as ./goal-score.js sorts it:
//      own goal: jobs of a type on their own goal, up to that goal;
//      team goal: jobs past it the team still needed (team goal credit);
//      company task: work outside the team's goals, at the time its timer ran,
//        never more than the time it was given;
//      covered: work taken over from someone who had started it.
//    Jobs the team didn't need are carried to next month: not counted now.
//  Points kept = the points their work earned ÷ the points the same work earns
//    on time and without much rework (lateness and send-backs cut it) — it
//    compares a person only with themselves, so a type's points don't matter.
//  Score, out of 1000 for everyone = Hours filled (counted up to 100%) ×
//    Points kept × 1000: the whole working time filled, all on time, is 1000.
//    Past 100% the hours still show; ties go to points.
import { closingFor, minutesOf, openingFor } from "./attendance.js";

export const HOURS_CAP = 100;
export const SCORE_MAX = 1000;

const tenth = (n) => Math.round(n * 10) / 10;

// How far into the month its working time is: each working day (by the office
// calendar) behind us counts whole, today by the office hours gone. A past
// month is all gone; a month ahead, none. weightOf(day): how much of a day is gone.
export function monthSoFar(cal, monthFirst, todayYmd, nowMinutes) {
  const [y, m] = monthFirst.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let total = 0, gone = 0, todayShare = 0;
  for (let d = 1; d <= last; d++) {
    const ymd = `${monthFirst.slice(0, 8)}${String(d).padStart(2, "0")}`;
    const open = openingFor(cal, ymd);
    if (!open) continue;
    total++;
    if (ymd < todayYmd) gone++;
    else if (ymd === todayYmd) {
      const a = minutesOf(open), b = minutesOf(closingFor(cal, ymd));
      todayShare = b > a ? Math.min(1, Math.max(0, (nowMinutes - a) / (b - a))) : 0;
      gone += todayShare;
    }
  }
  const weightOf = (day) => (day < todayYmd ? 1 : day === todayYmd ? todayShare : 0);
  return { total, gone, share: total ? gone / total : 0, weightOf };
}

// One person's hours and score. s: their ./goal-score.js month (scoreMonthAll);
// points / fullPoints: what their finished work earned, and earns at its best;
// soFar: monthSoFar for the month.
export function hoursScore(s, { points, fullPoints, completed }, soFar) {
  const hpd = Number(s?.hoursPerDay) || 8;
  const workingDays = Number(s?.workingDays) || soFar.total;
  const leaveDays = Number(s?.leaveDays) || 0;
  const leaveSoFar = (s?.leaveList ?? []).reduce((n, l) => n + l.days * soFar.weightOf(l.day), 0);
  const available = Math.max(0, workingDays * soFar.share - leaveSoFar) * hpd;
  const availableMonth = Math.max(0, workingDays - leaveDays) * hpd;
  const own = (s?.types ?? []).reduce((n, t) => n + Math.min(t.goalJC, (t.self ?? 0) + (t.assigned ?? 0)) * (t.jobHours ?? 0), 0);
  const team = Number(s?.creditHours) || 0;
  const company = Number(s?.otherHours) || 0;
  const covered = Number(s?.coveredHours) || 0;
  const earned = own + team + company + covered;
  const pct = available > 0 ? (earned / available) * 100 : null;
  const kept = fullPoints > 0 ? Math.max(0, Math.min(1, points / fullPoints)) * 100 : completed > 0 ? 100 : null;
  const score = pct != null && kept != null ? Math.round((Math.min(pct, HOURS_CAP) / 100) * (kept / 100) * SCORE_MAX) : null;
  return {
    hours: {
      available: tenth(available), availableMonth: tenth(availableMonth), earned: tenth(earned),
      own: tenth(own), team: tenth(team), company: tenth(company), covered: tenth(covered),
      pct: pct == null ? null : tenth(pct), workingDays, hoursPerDay: hpd, leaveDays, leaveSoFar: tenth(leaveSoFar),
    },
    keptPct: kept == null ? null : tenth(kept),
    fullPoints: tenth(fullPoints),
    score,
  };
}
