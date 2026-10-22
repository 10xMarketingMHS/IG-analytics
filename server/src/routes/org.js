import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission } from "../permissions.js";
import { hasColumn } from "../schema-flags.js";
import { CALENDAR_DEFAULTS, normalizeCalendar } from "../work-calendar.js";
import { ATTENDANCE_DEFAULTS, clearSettingsCache, normalizeAttendance } from "../attendance.js";
import { clearCapacityCache } from "./goals.js";
import { isSuperHere } from "../super-admin.js";

// Settings › General: the organisation's name, the week start and the work
// calendar. Anyone signed in can read them (the sidebar shows the name, date
// ranges use the week start, Goals uses the calendar). An admin changes the
// name, week start and attendance rules; only the Super Admin changes the work
// calendar, the attendance penalties and who sees the team's attendance.
export const orgRouter = Router();

const HHMM = z.string().regex(/^\d{2}:\d{2}$/);
const CalendarSchema = z.object({
  wdFrom: HHMM, wdTo: HHMM, satFrom: HHMM, satTo: HHMM,
  satOff: z.boolean(), satBreaks: z.boolean(),
  sickDays: z.number().int().min(0).max(10),
  adjustHours: z.number().int().min(-100).max(100),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).optional(),
});
const AttendanceSchema = z.object({
  requireSod: z.boolean(),
  graceMinutes: z.number().int().min(0).max(30),
  noSodAlertAt: HHMM,
  autoAbsentAt: HHMM,
  halfDayAt: HHMM.optional(),
  autoAbsentEnabled: z.boolean(),
  permissionsPerMonth: z.number().int().min(0).max(10).optional(),
  // CL applied for fewer days ahead is short notice (leave.js)
  clNoticeDays: z.number().int().min(0).max(14).optional(),
  requireEodNote: z.boolean(),
  allowCorrections: z.boolean(),
  latePenaltyPts: z.number().int().min(0).max(10),
  absentPenaltyPts: z.number().int().min(0).max(10),
  deductCapacity: z.boolean(),
  teamView: z.object({ manager: z.boolean(), asstManager: z.boolean(), teamLead: z.boolean() }).optional(),
});
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  weekStart: z.enum(["mon", "sun"]).optional(),
  calendar: CalendarSchema.optional(),
  attendance: AttendanceSchema.optional(),
});

async function readOrg(orgId) {
  const withSettings = await hasColumn("org", "settings");
  const { rows } = await pool.query(
    `select name${withSettings ? ", settings" : ""} from org where id = $1`, [orgId],
  );
  const s = rows[0]?.settings ?? {};
  return {
    name: rows[0]?.name ?? "",
    weekStart: s.weekStart === "sun" ? "sun" : "mon",
    calendar: normalizeCalendar(s.calendar),
    calendarSaved: !!s.calendar,
    attendance: normalizeAttendance(s.attendance),
    canSaveSettings: withSettings,
  };
}

orgRouter.get("/org", async (req, res, next) => {
  try {
    // superAdmin: whether this person may change the Super Admin settings here
    const [org, superAdmin] = await Promise.all([readOrg(req.orgId), isSuperHere(req)]);
    res.json({ org: { ...org, superAdmin }, calendarDefaults: CALENDAR_DEFAULTS, attendanceDefaults: ATTENDANCE_DEFAULTS });
  } catch (err) {
    next(err);
  }
});

orgRouter.patch("/org", requirePermission("edit_goals"), async (req, res, next) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Those settings don't look right." });
  const d = parsed.data;
  if ((d.name !== undefined || d.weekStart !== undefined || d.attendance !== undefined) && req.role !== "admin") {
    return res.status(403).json({ error: "Only an admin can change the workspace name, week start or attendance rules." });
  }
  try {
    // The work calendar, the attendance penalties and who sees the team's
    // attendance are the Super Admin's call. A save sends the whole card, so
    // only what actually changes counts.
    if (d.calendar || d.attendance) {
      const cur = await readOrg(req.orgId);
      const superOnly = [];
      if (d.calendar && Object.keys(d.calendar).some((k) => JSON.stringify(cur.calendar[k] ?? null) !== JSON.stringify(normalizeCalendar(d.calendar)[k] ?? null))) superOnly.push("the work calendar");
      if (d.attendance && ["latePenaltyPts", "absentPenaltyPts", "deductCapacity"].some((k) => cur.attendance[k] !== d.attendance[k])) superOnly.push("the attendance penalties");
      if (d.attendance?.clNoticeDays != null && cur.attendance.clNoticeDays !== d.attendance.clNoticeDays) superOnly.push("the CL notice");
      if (d.attendance?.teamView && ["manager", "asstManager", "teamLead"].some((k) => cur.attendance.teamView[k] !== d.attendance.teamView[k])) superOnly.push("who sees the team's attendance");
      if (superOnly.length && !(await isSuperHere(req))) {
        return res.status(403).json({ error: `Only a Super Admin can change ${superOnly.join(" or ")}.` });
      }
    }
    // Penalties changed: log them from this month on, so past months keep the
    // points they were charged at (attendance.js penaltiesFor).
    if (d.attendance && (await hasColumn("org", "settings"))) {
      const { rows: o } = await pool.query("select settings->'attendance' as a from org where id = $1", [req.orgId]);
      const rawAtt = o[0]?.a ?? {};
      const old = normalizeAttendance(rawAtt);
      if (old.latePenaltyPts !== d.attendance.latePenaltyPts || old.absentPenaltyPts !== d.attendance.absentPenaltyPts) {
        const ist = new Date(Date.now() + 330 * 60_000);
        const month = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
        const log = Array.isArray(rawAtt.penaltyLog) && rawAtt.penaltyLog.length
          ? rawAtt.penaltyLog.filter((e) => String(e.from) < month)
          : [{ from: "0000-00", late: old.latePenaltyPts, absent: old.absentPenaltyPts }];
        log.push({ from: month, late: d.attendance.latePenaltyPts, absent: d.attendance.absentPenaltyPts });
        d.attendance.penaltyLog = log;
      }
    }
    if (d.name !== undefined) await pool.query("update org set name = $2 where id = $1", [req.orgId, d.name]);
    if (d.weekStart !== undefined || d.calendar !== undefined || d.attendance !== undefined) {
      if (!(await hasColumn("org", "settings"))) {
        return res.status(409).json({ error: "These settings need a database update first — ask whoever runs the database to apply 20261023120000_org_settings_notify_prefs." });
      }
      const patch = {};
      if (d.weekStart !== undefined) patch.weekStart = d.weekStart;
      if (d.calendar !== undefined) patch.calendar = normalizeCalendar(d.calendar);
      await pool.query("update org set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1", [req.orgId, JSON.stringify(patch)]);
      // Attendance merges, so the date attendance started (since) is kept.
      if (d.attendance !== undefined) {
        await pool.query(
          `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attendance}',
             coalesce(settings->'attendance', '{}'::jsonb) || $2::jsonb) where id = $1`,
          [req.orgId, JSON.stringify(d.attendance)],
        );
      }
      // what's kept for a few seconds (settings, capacity from the calendar) is stale now
      clearSettingsCache(req.orgId);
      clearCapacityCache(req.orgId);
    }
    res.json({ org: await readOrg(req.orgId) });
  } catch (err) {
    next(err);
  }
});
