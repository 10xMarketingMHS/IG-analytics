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

// A session nobody ended (End Work forgotten, browser closed) would otherwise
// stay open for days: the person never sees Start Work again, their hours keep
// growing, and the admin's page shows them as not started. Once its day is over
// it's closed at 6 PM office close, IST (or at its start, if it began later than
// that) and flagged auto_closed so the admin can tell. Runs before anything
// reads work-day state; at most once a minute per server.
let lastSweep = 0;
export async function closeStaleSessions() {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  await pool.query(
    `update eod_session
        set ended_at = greatest(started_at, (date + time '18:00') at time zone 'Asia/Kolkata'),
            auto_closed = true
      where ended_at is null and date < current_date`,
  );
}

// The daily summary for one editor on one date — aggregated across every session
// that day (handles Start/End/Start). Completed = tasks marked done whose
// completion time falls inside any of that day's session windows. dueToday reuses
// My Day's "due today" definition (due_date == the workday) and dueTodayDone is
// how many of those are done — a separate figure from Completed, since work
// finished today is often due another day. Working hours run
// from the day's first start to its last end (null while a session is still open).
async function summaryFor(orgId, editorId, date) {
  const { rows: sessions } = await pool.query(
    `select id, started_at as "startedAt", ended_at as "endedAt", auto_closed as "autoClosed"
       from eod_session where editor_id = $1 and org_id = $2 and date = $3
       order by started_at`,
    [editorId, orgId, date],
  );
  if (!sessions.length) {
    return { date, status: "not_started", startedAt: null, endedAt: null, groups: [], completedCount: 0, dueToday: 0, dueTodayDone: 0 };
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
    `select count(*)::int as n, (count(*) filter (where t.status = 'done'))::int as done
       from task t where t.editor_id = $1 and t.org_id = $2 and t.due_date = $3`,
    [editorId, orgId, date],
  );
  // First start → last end hides any gap between sessions, so also report the
  // time actually clocked in, how many sessions that was, and the day's breaks.
  const workedSeconds = Math.round(sessions.reduce(
    (n, s) => n + ((s.endedAt ? new Date(s.endedAt) : new Date()) - new Date(s.startedAt)) / 1000, 0,
  ));
  const autoClosed = sessions.some((s) => s.autoClosed);
  // Breaks are one running total per day on the editor row (breaks.js dates it
  // in UTC) — shown when it belongs to one of this day's sessions.
  const { rows: br } = await pool.query(
    "select break_used_seconds, break_started_at, break_date from editor where id = $1", [editorId],
  );
  const sessionDays = new Set(sessions.map((s) => new Date(s.startedAt).toISOString().slice(0, 10)));
  let breakSeconds = null;
  if (br[0]?.break_date && sessionDays.has(String(br[0].break_date).slice(0, 10))) {
    const running = br[0].break_started_at ? Math.max(0, (Date.now() - new Date(br[0].break_started_at)) / 1000) : 0;
    breakSeconds = Math.round(Math.min(75 * 60, Number(br[0].break_used_seconds ?? 0) + running));
  }
  // The morning plan (SOD), if one was sent: how much of it got done, what
  // didn't, and what was worked on outside it after it was sent (new tasks, or
  // tasks finished that weren't in it).
  let plan = null;
  const { rows: pr } = await pool.query(
    "select submitted_at, note, tasks from sod_plan where editor_id = $1 and org_id = $2 and date = $3",
    [editorId, orgId, date],
  );
  if (pr[0]) {
    // Tasks the employee left out of today's plan ("skipped") don't count, and
    // nor does a planned task an admin deleted during the day — it's listed as
    // removed instead of counting against them as not done.
    const planned = (pr[0].tasks ?? []).filter((t) => t.group !== "skipped");
    const ids = planned.map((t) => t.id);
    const { rows: cur } = await pool.query("select id, title, status from task where id = any($1::uuid[])", [ids]);
    const byId = new Map(cur.map((t) => [t.id, t]));
    const removed = planned.filter((t) => !byId.has(t.id)).map((t) => t.title);
    const kept = planned.filter((t) => byId.has(t.id));
    const notDone = kept.filter((t) => byId.get(t.id).status !== "done").map((t) => byId.get(t.id).title);
    const { rows: extra } = await pool.query(
      `select title from task
        where editor_id = $1 and org_id = $2 and not (id = any($3::uuid[]))
          and ((created_at > $4 and created_at::date = $5::date)
               or (status = 'done' and completed_at > $4 and completed_at::date = $5::date))
        order by created_at`,
      [editorId, orgId, ids, pr[0].submitted_at, date],
    );
    plan = {
      submittedAt: pr[0].submitted_at, note: pr[0].note,
      plannedCount: kept.length, doneCount: kept.length - notDone.length,
      notDone, removed, unplanned: extra.map((t) => t.title),
    };
  }
  return {
    date, status: anyOpen ? "active" : "completed", startedAt, endedAt, groups, completedCount,
    dueToday: due[0].n, dueTodayDone: due[0].done,
    workedSeconds, sessionCount: sessions.length, breakSeconds, autoClosed, plan,
  };
}

// The caller's currently-open session (null if none) — drives the frontend gate.
eodRouter.get("/eod/status", async (req, res, next) => {
  try {
    await closeStaleSessions();
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
    await closeStaleSessions();
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
    if (!rows.length) return res.status(400).json({ error: "You haven't started work, so there's nothing to end." });
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
    await closeStaleSessions();
    res.json({ summary: await summaryFor(req.orgId, editorId, date) });
  } catch (err) { next(err); }
});

// Admin oversight — every (non-admin) editor's EOD status for a date.
eodRouter.get("/eod/team", requireAdmin, async (req, res, next) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "A valid date is required." });
    await closeStaleSessions();
    const { rows } = await pool.query(
      `select e.id, e.name,
              coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)), 0)::int as "workedSeconds",
              coalesce(bool_or(s.auto_closed), false) as "autoClosed",
              (select p.submitted_at from sod_plan p where p.editor_id = e.id and p.date = $2) as "planSubmittedAt",
              (select count(*)::int from sod_plan p, jsonb_array_elements(p.tasks) x
                 where p.editor_id = e.id and p.date = $2 and x->>'group' <> 'skipped') as "planCount",
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
      sessions: r.sessions,
      workedSeconds: r.workedSeconds,
      autoClosed: r.autoClosed,
      planSubmittedAt: r.planSubmittedAt,
      planCount: r.planCount,
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
    await closeStaleSessions();
    const { rowCount } = await pool.query(
      "select 1 from eod_session where editor_id = $1 and ended_at is null limit 1",
      [eid],
    );
    if (!rowCount) return res.status(403).json({ error: "Press Start Work before working on tasks." });
    next();
  } catch (err) { next(err); }
}
