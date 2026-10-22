// Leave maths (src/leave-math.js) against the cases in "Leave CL-SL spec.md"
// (Tests), on its own dates: today is Thu 22 Oct 2026. No database:
// npm run test:leave
const M = await import("../src/leave-math.js");
let ok = 0, bad = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  (" + extra + ")" : ""}`); cond ? ok++ : bad++; };
const wd = (y) => new Date(`${y}T00:00:00Z`).getUTCDay();
const satWorking = (y) => wd(y) !== 0;
const satOff = (y) => wd(y) !== 0 && wd(y) !== 6;
const today = "2026-10-22"; // Thursday
const rules = { ...M.LEAVE_DEFAULTS };

console.log("-- Notice (working days from today, counting today, to the day before)");
check("Thu → Fri: 1 working day, short", M.noticeOf(satWorking, today, "2026-10-23") === 1);
let p = M.priceRequest({ type: "CL", days: 1, from: "2026-10-23", today, isWorking: satWorking, rules, total: 2, used: 0 });
check("CL Thu for Fri: short, −2", p.short && p.pts === 2, JSON.stringify({ short: p.short, pts: p.pts }));
check("Thu → Sat (Saturday worked): 2, OK", M.noticeOf(satWorking, today, "2026-10-24") === 2);
p = M.priceRequest({ type: "CL", days: 1, from: "2026-10-24", today, isWorking: satWorking, rules, total: 2, used: 0 });
check("CL Thu for Sat: not short, no cut", !p.short && p.pts === 0);
check("Saturday off → Mon: Thu, Fri = 2, OK", M.noticeOf(satOff, today, "2026-10-26") === 2);
p = M.priceRequest({ type: "CL", days: 1, from: "2026-10-26", today, isWorking: satOff, rules, total: 2, used: 0 });
check("CL Thu for Mon (Saturday off): not short", !p.short);
check("A leave starting today has no notice", M.noticeOf(satWorking, today, today) === 0);
p = M.priceRequest({ type: "SL", days: 1, from: "2026-10-23", today, isWorking: satWorking, rules, total: 4, used: 0 });
check("SL never needs notice", !p.short && p.notice === null);

console.log("-- Balance: paid first, then unpaid");
const d3 = M.daysOf(satWorking, "2026-10-26", "2026-10-28");
p = M.priceRequest({ type: "CL", days: d3, from: "2026-10-26", today, isWorking: satWorking, rules, total: 2, used: 0 });
check("A (2 CL) asks 3 CL with notice → 2 paid + 1 unpaid, −3 pts", p.paid === 2 && p.unpaid === 1 && p.pts === 3 && !p.short, JSON.stringify(p));
p = M.priceRequest({ type: "CL", days: 1, from: "2026-10-23", today, isWorking: satWorking, rules, total: 2, used: 2 });
check("No CL left + short notice: 1 unpaid, −2 −3 = −5", p.paid === 0 && p.unpaid === 1 && p.pts === 5, JSON.stringify(p));
p = M.priceRequest({ type: "CL", days: 1, from: "2026-10-26", today, isWorking: satWorking, rules, total: 2, used: 5 });
check("Allowance lowered below what's used: left 0, all unpaid", p.left === 0 && p.unpaid === 1);
let s = M.resplit({ days: 2, total: 2, usedByOthers: 1, shortPts: 2, unpaidRate: 3 });
check("Re-split at approval: 1 paid, 1 unpaid, −5 (rates kept)", s.paid === 1 && s.unpaid === 1 && s.pts === 5);
s = M.resplit({ days: 2, total: 2, usedByOthers: 0, shortPts: 0, unpaidRate: 3 });
check("…and a day freed since: both paid, no cut", s.paid === 2 && s.unpaid === 0 && s.pts === 0);

console.log("-- Days");
check("Half-day SL → 0.5", M.daysOf(satWorking, "2026-10-23", "2026-10-23", "first") === 0.5);
check("A half day on a Sunday → 0 (refused)", M.daysOf(satWorking, "2026-10-25", "2026-10-25", "second") === 0);
check("Mon–Sun with Saturday worked → 6", M.daysOf(satWorking, "2026-10-26", "2026-11-01") === 6);
check("…with Saturday off → 5", M.daysOf(satOff, "2026-10-26", "2026-11-01") === 5);

console.log("-- What's refused");
const chk = (o) => M.checkRequest({ today, isWorking: satWorking, half: "full", ...o });
check("CL for a past day", /past day/.test(chk({ type: "CL", from: "2026-10-21", to: "2026-10-21" }) ?? ""));
check("SL 7 days back is fine", chk({ type: "SL", from: "2026-10-15", to: "2026-10-15" }) === null);
check("SL 8 days back is refused", /7 days/.test(chk({ type: "SL", from: "2026-10-14", to: "2026-10-14" }) ?? ""));
check("A half day over two days", /one day/.test(chk({ type: "SL", from: "2026-10-23", to: "2026-10-24", half: "first" }) ?? ""));
check("More than 30 working days", /30 working days/.test(chk({ type: "CL", from: "2026-10-26", to: "2026-12-10" }) ?? ""));
check("Only off days", /No working days/.test(chk({ type: "CL", from: "2026-10-25", to: "2026-10-25" }) ?? ""));
check("To before From", /before/.test(chk({ type: "CL", from: "2026-10-27", to: "2026-10-26" }) ?? ""));

console.log("-- Year end and frozen months");
const y = M.splitByYear("2026-12-30", "2027-01-02");
check("30 Dec – 2 Jan splits into this year and next", JSON.stringify(y) === JSON.stringify([["2026-12-30", "2026-12-31"], ["2027-01-01", "2027-01-02"]]), JSON.stringify(y));
p = M.priceRequest({ type: "CL", days: 1, from: "2026-12-30", today: "2026-12-29", isWorking: satWorking, rules, total: 2, used: 0, shortApplies: false });
check("The second part of a split never charges short notice again", !p.short && p.pts === 0);
check("September is frozen on 22 Oct", M.monthFrozen("2026-09", today));
check("…but still open on 5 Oct (10 days to settle)", !M.monthFrozen("2026-09", "2026-10-05"));
check("August is frozen on 5 Oct", M.monthFrozen("2026-08", "2026-10-05"));
check("This month is never frozen", !M.monthFrozen("2026-10", today));
check("A range touching September is frozen on 22 Oct", M.rangeFrozen("2026-09-30", "2026-10-02", today) === "2026-09");

console.log("-- Dates that aren't real, and long ranges");
check("22 Oct 2026 is a real date", M.validYmd("2026-10-22"));
check("Month 13, 30 Feb and year 9999 aren't", !M.validYmd("2026-13-01") && !M.validYmd("2026-02-30") && !M.validYmd("9999-12-31"));
let t0 = Date.now();
let bad9999 = M.checkRequest({ type: "SL", from: today, to: "9999-12-31", today, isWorking: satWorking });
check("A request to 31 Dec 9999 is refused at once", bad9999 === "Pick real dates." && Date.now() - t0 < 200, `${bad9999} in ${Date.now() - t0} ms`);
t0 = Date.now();
bad9999 = M.checkRequest({ type: "SL", from: today, to: "2100-12-31", today, isWorking: satWorking });
check("…and one to 2100 before counting its days", /Up to 30/.test(bad9999 ?? "") && Date.now() - t0 < 200, `${bad9999} in ${Date.now() - t0} ms`);
check("Working days are never counted past a year and a bit", M.workingDates(satWorking, "2026-01-01", "2099-12-31").length <= 400);

console.log("-- A leave with every day worked costs nothing");
const s0 = M.resplit({ days: 0, total: 2, usedByOthers: 0, shortPts: 2, unpaidRate: 3 });
check("1-day short-notice CL, worked after all: 0 days, 0 pts", s0.paid === 0 && s0.unpaid === 0 && s0.pts === 0, JSON.stringify(s0));
const s1 = M.resplit({ days: 1, total: 2, usedByOthers: 0, shortPts: 2, unpaidRate: 3 });
check("…put back (Undo Start day): the short-notice cut again", s1.pts === 2, JSON.stringify(s1));

console.log(`\n${ok} passed, ${bad} failed.`);
process.exit(bad ? 1 : 0);
