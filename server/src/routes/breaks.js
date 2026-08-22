import { Router } from "express";
import { pool } from "../db.js";

export const breaksRouter = Router();

// Office breaks: lunch (45m) + two tea breaks (15m each) = 75m/day, shared
// across however many tasks are running — pausing stops all of them at once.
// A break can't be ended before 5 minutes in (stops break/resume spam), and
// auto-caps at the daily total — once used_seconds would exceed it, the
// break is treated as already over from that point on, without needing a
// live timer anywhere (see resolveBreak below).
const DAILY_CAP_SECONDS = 75 * 60;
const MIN_BREAK_SECONDS = 5 * 60;

async function callerEditorId(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}

// Reads the editor's break row, rolling used_seconds over to 0 if it's a new
// day, and reports the *effective* state right now — if currently on break
// but elapsed time already exceeds what's left of the daily cap, it reports
// as no-longer-on-break (the caller then persists that via resolveBreak).
async function loadBreakState(editorId) {
  const { rows } = await pool.query(
    "select break_started_at, break_used_seconds, break_date from editor where id = $1",
    [editorId],
  );
  const row = rows[0];
  if (!row) return null;
  const today = new Date().toISOString().slice(0, 10);
  const isToday = row.break_date && new Date(row.break_date).toISOString().slice(0, 10) === today;
  const usedSeconds = isToday ? row.break_used_seconds : 0;
  const startedAt = isToday ? row.break_started_at : null;

  if (!startedAt) {
    return { onBreak: false, usedSeconds, remainingSeconds: Math.max(0, DAILY_CAP_SECONDS - usedSeconds) };
  }
  const elapsed = Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000);
  const remainingCap = Math.max(0, DAILY_CAP_SECONDS - usedSeconds);
  if (elapsed >= remainingCap) {
    // The break auto-expired — effectively over, even though nothing has
    // explicitly ended it in the database yet.
    return { onBreak: false, usedSeconds: DAILY_CAP_SECONDS, remainingSeconds: 0, autoExpired: true };
  }
  return { onBreak: true, startedAt, usedSeconds, remainingSeconds: remainingCap - elapsed };
}

// Persist an auto-expired break so the DB reflects it (idempotent — safe to
// call whenever any request notices the break has run out).
async function resolveBreak(editorId, state) {
  if (state?.autoExpired) {
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      "update editor set break_started_at = null, break_used_seconds = $1, break_date = $2 where id = $3",
      [DAILY_CAP_SECONDS, today, editorId],
    );
  }
}

breaksRouter.get("/break/status", async (req, res, next) => {
  try {
    const editorId = await callerEditorId(req);
    if (!editorId) return res.json({ onBreak: false, usedSeconds: 0, remainingSeconds: DAILY_CAP_SECONDS, unlinked: true });
    const state = await loadBreakState(editorId);
    await resolveBreak(editorId, state);
    res.json({ ...state, dailyCapSeconds: DAILY_CAP_SECONDS, minBreakSeconds: MIN_BREAK_SECONDS });
  } catch (err) {
    next(err);
  }
});

breaksRouter.post("/break/start", async (req, res, next) => {
  try {
    const editorId = await callerEditorId(req);
    if (!editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const state = await loadBreakState(editorId);
    await resolveBreak(editorId, state);
    if (state.onBreak) return res.json({ ...state, dailyCapSeconds: DAILY_CAP_SECONDS, minBreakSeconds: MIN_BREAK_SECONDS });
    if (state.remainingSeconds <= 0) {
      return res.status(409).json({ error: "No break time left today." });
    }
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      "update editor set break_started_at = now(), break_used_seconds = $1, break_date = $2 where id = $3",
      [state.usedSeconds, today, editorId],
    );
    const updated = await loadBreakState(editorId);
    res.json({ ...updated, dailyCapSeconds: DAILY_CAP_SECONDS, minBreakSeconds: MIN_BREAK_SECONDS });
  } catch (err) {
    next(err);
  }
});

breaksRouter.post("/break/end", async (req, res, next) => {
  try {
    const editorId = await callerEditorId(req);
    if (!editorId) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const state = await loadBreakState(editorId);
    if (!state.onBreak) {
      await resolveBreak(editorId, state);
      return res.json({ ...state, dailyCapSeconds: DAILY_CAP_SECONDS, minBreakSeconds: MIN_BREAK_SECONDS });
    }
    const elapsed = (Date.now() - new Date(state.startedAt).getTime()) / 1000;
    // Force-allow ending early only once the daily cap is basically spent —
    // otherwise hold to the 5-minute floor so pause/resume can't be spammed.
    if (elapsed < MIN_BREAK_SECONDS && state.remainingSeconds > (MIN_BREAK_SECONDS - elapsed)) {
      const waitSeconds = Math.ceil(MIN_BREAK_SECONDS - elapsed);
      return res.status(409).json({ error: `Breaks are at least 5 minutes — ${waitSeconds}s to go.` });
    }
    const usedSeconds = Math.min(DAILY_CAP_SECONDS, state.usedSeconds + elapsed);
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      "update editor set break_started_at = null, break_used_seconds = $1, break_date = $2 where id = $3",
      [Math.round(usedSeconds), today, editorId],
    );
    const updated = await loadBreakState(editorId);
    res.json({ ...updated, dailyCapSeconds: DAILY_CAP_SECONDS, minBreakSeconds: MIN_BREAK_SECONDS });
  } catch (err) {
    next(err);
  }
});
