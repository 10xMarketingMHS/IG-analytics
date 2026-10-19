import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission } from "../permissions.js";
import { hasColumn } from "../schema-flags.js";
import { CALENDAR_DEFAULTS, normalizeCalendar } from "../work-calendar.js";
import { ATTENDANCE_DEFAULTS, normalizeAttendance } from "../attendance.js";

// Settings › General: the organisation's name, the week start and the work
// calendar. Anyone signed in can read them (the sidebar shows the name, date
// ranges use the week start, Goals uses the calendar). An admin changes the
// name and week start; an admin or an edit_goals grantee the calendar.
export const orgRouter = Router();

const HHMM = z.string().regex(/^\d{2}:\d{2}$/);
const CalendarSchema = z.object({
  wdFrom: HHMM, wdTo: HHMM, satFrom: HHMM, satTo: HHMM,
  satOff: z.boolean(), satBreaks: z.boolean(),
  sickDays: z.number().int().min(0).max(10),
  adjustHours: z.number().int().min(-100).max(100),
});
const AttendanceSchema = z.object({
  requireSod: z.boolean(),
  graceMinutes: z.number().int().min(0).max(30),
  noSodAlertAt: HHMM,
  autoAbsentAt: HHMM,
  autoAbsentEnabled: z.boolean(),
  requireEodNote: z.boolean(),
  allowCorrections: z.boolean(),
  latePenaltyPts: z.number().int().min(0).max(10),
  absentPenaltyPts: z.number().int().min(0).max(10),
  deductCapacity: z.boolean(),
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
    res.json({ org: await readOrg(req.orgId), calendarDefaults: CALENDAR_DEFAULTS, attendanceDefaults: ATTENDANCE_DEFAULTS });
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
    if (d.name !== undefined) await pool.query("update org set name = $2 where id = $1", [req.orgId, d.name]);
    if (d.weekStart !== undefined || d.calendar !== undefined || d.attendance !== undefined) {
      if (!(await hasColumn("org", "settings"))) {
        return res.status(409).json({ error: "These settings need a database update first — ask whoever runs the database to apply 20261023120000_org_settings_notify_prefs." });
      }
      const patch = {};
      if (d.weekStart !== undefined) patch.weekStart = d.weekStart;
      if (d.calendar !== undefined) patch.calendar = d.calendar;
      await pool.query("update org set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1", [req.orgId, JSON.stringify(patch)]);
      // Attendance merges, so the date attendance started (since) is kept.
      if (d.attendance !== undefined) {
        await pool.query(
          `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attendance}',
             coalesce(settings->'attendance', '{}'::jsonb) || $2::jsonb) where id = $1`,
          [req.orgId, JSON.stringify(d.attendance)],
        );
      }
    }
    res.json({ org: await readOrg(req.orgId) });
  } catch (err) {
    next(err);
  }
});
