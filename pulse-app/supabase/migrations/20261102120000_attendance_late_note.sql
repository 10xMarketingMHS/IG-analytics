-- Why a late start: what the person tells their lead when Start day comes
-- after the grace period (late, half-day absent or absent). Pulse asks for it
-- as soon as the day has started late (server/src/routes/attendance.js,
-- POST /attendance/late-reason); leads see it on Team today and
-- Team › Attendance. Safe to run more than once.
alter table public.attendance add column if not exists late_note text;
