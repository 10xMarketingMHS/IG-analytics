import { Router } from "express";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";

// Start/End EOD — one clock-in session per editor per workday. Editors are
// gated out of the whole app (and, server-side, task mutations) until they Start
// EOD; End EOD closes the session and produces the daily summary. Admins/viewers
// never clock in. See migration 20260915160000_eod_session.sql.
export const eodRouter = Router();

async function callerEditorId(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}

// The daily summary for one editor on one date — aggregated across every session
// that day (handles Start/End/Start). Completed = tasks marked done whose
// completion time falls inside any of that day's session windows. dueToday reuses
// My Day's "due today" definition (due_date == the workday). Working hours run
// from the day's first start to its last end (null while a session is still open).
async function summaryFor(orgId, editorId, date) {
  const { rows: sessions } = await pool.query(
    `select id, started_at as "startedAt", ended_at as "endedAt"
       from eod_session where editor_id = $1 and org_id = $2 and date = $3
       order by started_at`,
    [editorId, orgId, date],
  );
  if (!sessions.length) {
    return { date, status: "not_started", startedAt: null, endedAt: null, groups: [], completedCount: 0, dueToday: 0 };
  }
  const anyOpen = sessions.some((s) => !s.endedAt);
  const startedAt = sessions[0].startedAt;
  const endedAt = anyOpen ? null : sessions.reduce((m, s) => (s.endedAt > m ? s.endedAt : m), sessions[0].endedAt);

  // Completed tasks grouped by content type (format name), within any session window.
  const { rows: groups } = await pool.query(
    `select coalesce(cf.name, 'Task') as label, count(*)::int as n
       from task t
       left join task_content_format cf on cf.id = t.content_format_id
      where t.editor_id = $1 and t.org_id = $2 and t.status = 'done' and t.completed_at is not null
        and exists (
          select 1 from eod_session s
           where s.editor_id = $1 and s.date = $3
             and t.completed_at >= s.started_at
             and t.completed_at <= coalesce(s.ended_at, now())
        )
      group by 1 order by n desc, label`,
    [editorId, orgId, date],
  );
  const completedCount = groups.reduce((a, g) => a + g.n, 0);
  const { rows: due } = await pool.query(
    "select count(*)::int as n from task t where t.editor_id = $1 and t.org_id = $2 and t.due_date = $3",
    [editorId, orgId, date],
  );
  return { date, status: anyOpen ? "active" : "completed", startedAt, endedAt, groups, completedCount, dueToday: due[0].n };
}

// The caller's currently-open session (null if none) — drives the frontend gate.
eodRouter.get("/eod/status", async (req, res, next) => {
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.json({ session: null, unlinked: true });
    const { rows } = await pool.query(
      `select id, date, started_at as "startedAt", ended_at as "endedAt"
         from eod_session where editor_id = $1 and ended_at is null limit 1`,
      [eid],
    );
    res.json({ session: rows[0] ?? null });
  } catch (err) { next(err); }
});

// Start EOD — idempotent: returns the existing open session if there is one.
eodRouter.post("/eod/start", async (req, res, next) => {
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const open = await pool.query(
      `select id, date, started_at as "startedAt", ended_at as "endedAt"
         from eod_session where editor_id = $1 and ended_at is null limit 1`,
      [eid],
    );
    if (open.rows.length) return res.json({ session: open.rows[0] });
    try {
      const { rows } = await pool.query(
        `insert into eod_session (org_id, editor_id, date, started_at)
         values ($1, $2, current_date, now())
         returning id, date, started_at as "startedAt", ended_at as "endedAt"`,
        [req.orgId, eid],
      );
      res.status(201).json({ session: rows[0] });
    } catch (e) {
      // Lost a race to the partial-unique index — return whoever won.
      if (e.code === "23505") {
        const { rows } = await pool.query(
          `select id, date, started_at as "startedAt", ended_at as "endedAt"
             from eod_session where editor_id = $1 and ended_at is null limit 1`,
          [eid],
        );
        return res.json({ session: rows[0] ?? null });
      }
      throw e;
    }
  } catch (err) { next(err); }
});

// End EOD — closes the open session and returns the day's summary.
eodRouter.patch("/eod/end", async (req, res, next) => {
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { rows } = await pool.query(
      `update eod_session set ended_at = now()
        where editor_id = $1 and ended_at is null
        returning id, date, started_at as "startedAt", ended_at as "endedAt"`,
      [eid],
    );
    if (!rows.length) return res.status(400).json({ error: "No active EOD session to end." });
    const summary = await summaryFor(req.orgId, eid, rows[0].date);
    res.json({ session: rows[0], summary });
  } catch (err) { next(err); }
});

// A summary for a date — self by default; admins may pass ?editorId= for anyone.
eodRouter.get("/eod/summary", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "A valid date is required." });
    let editorId = req.query.editorId ? String(req.query.editorId) : null;
    if (editorId && req.role !== "admin") return res.status(403).json({ error: "Admins only." });
    if (!editorId) editorId = await callerEditorId(req);
    if (!editorId) return res.status(400).json({ error: "No editor to summarize." });
    res.json({ summary: await summaryFor(req.orgId, editorId, date) });
  } catch (err) { next(err); }
});

// Admin oversight — every (non-admin) editor's EOD status for a date.
eodRouter.get("/eod/team", requireAdmin, async (req, res, next) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "A valid date is required." });
    const { rows } = await pool.query(
      `select e.id, e.name,
              min(s.started_at) as "startedAt",
              max(s.ended_at)   as "endedAt",
              bool_or(s.ended_at is null) as "anyOpen",
              count(s.id)::int  as "sessions"
         from editor e
         left join eod_session s on s.editor_id = e.id and s.date = $2
        where e.org_id = $1 and e.active
          and not exists (
            select 1 from app_user u join membership m on m.user_id = u.id
             where u.editor_id = e.id and m.role = 'admin'
          )
        group by e.id, e.name
        order by e.name`,
      [req.orgId, date],
    );
    const editors = rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.sessions === 0 ? "not_started" : (r.anyOpen ? "active" : "completed"),
      startedAt: r.startedAt,
      endedAt: r.anyOpen ? null : r.endedAt,
    }));
    res.json({ date, editors });
  } catch (err) { next(err); }
});

// ---- Enforcement: task mutations require an active EOD session (editors only) ----
// Admins/viewers pass through (admins are exempt from the gate; viewers can't
// mutate tasks anyway). Applied to POST /tasks (incl. Admin Tasks, which skip
// accept), POST /tasks/:id/accept, and PATCH /tasks/:id.
export async function requireActiveEod(req, res, next) {
  try {
    if (req.role !== "editor") return next();
    const eid = await callerEditorId(req);
    if (!eid) return next(); // no roster link — no session to require
    const { rowCount } = await pool.query(
      "select 1 from eod_session where editor_id = $1 and ended_at is null limit 1",
      [eid],
    );
    if (!rowCount) return res.status(403).json({ error: "Start your EOD session before working on tasks." });
    next();
  } catch (err) { next(err); }
}
