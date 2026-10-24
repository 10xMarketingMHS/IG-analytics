import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";
import { hasColumn } from "../schema-flags.js";

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
  // …and their task clocks stop where the day was closed (see pauseDayTimers);
  // one started after the close stops too, with nothing banked. The day is
  // India's: a session is stale once India's date has moved on.
  await pool.query(
    `with closed as (
       update eod_session
          set ended_at = greatest(started_at, (date + time '18:00') at time zone 'Asia/Kolkata'),
              auto_closed = true
        where ended_at is null and date < (now() at time zone 'Asia/Kolkata')::date
        returning editor_id, ended_at, date
     )
     update task t
        set budget_used_seconds = coalesce(t.budget_used_seconds, 0)
              + greatest(0, extract(epoch from c.ended_at - t.budget_started_at)
                            - case when e.break_date = c.date then coalesce(e.break_used_seconds, 0) else 0 end),
            budget_started_at = null
       from closed c join editor e on e.id = c.editor_id
      where t.editor_id = c.editor_id and t.status = 'in_progress' and t.accepted and not t.on_hold
        and t.budget_hours is not null and t.budget_started_at is not null`,
  );
}

// Today's break so far for the task's person, as the board nets it out of a
// running clock (lib/task-timing.ts breakOffsetMs): what's banked plus the
// break under way, capped at the day's 75 minutes.
const BREAK_NOW = `(case when e.break_date = (now() at time zone 'Asia/Kolkata')::date
    then coalesce(e.break_used_seconds, 0)
       + case when e.break_started_at is not null
              then least(greatest(0, extract(epoch from now() - e.break_started_at)), greatest(0, 4500 - coalesce(e.break_used_seconds, 0)))
              else 0 end
    else 0 end)`;

// Closing the day stops every running clock on that person's tasks: the time
// so far (less today's breaks) is banked and the clock waits, the task still
// In Progress, accepted and not on hold, until they start their day again.
export async function pauseDayTimers(eid) {
  await pool.query(
    `update task t
        set budget_used_seconds = coalesce(t.budget_used_seconds, 0)
              + greatest(0, extract(epoch from now() - t.budget_started_at) - ${BREAK_NOW}),
            budget_started_at = null
       from editor e
      where e.id = t.editor_id and t.editor_id = $1 and t.status = 'in_progress' and t.accepted and not t.on_hold
        and t.budget_hours is not null and t.budget_started_at is not null and t.budget_started_at <= now()`,
    [eid],
  );
}

// Starting (or reopening) the day: those clocks run on from what was banked.
// The start point also allows for today's breaks so far, which the board
// takes off again, so the time shown carries straight on.
async function resumeDayTimers(eid) {
  await pool.query(
    `update task t
        set budget_started_at = now() - make_interval(secs => (coalesce(t.budget_used_seconds, 0) + ${BREAK_NOW})::double precision),
            budget_used_seconds = 0
       from editor e
      where e.id = t.editor_id and t.editor_id = $1 and t.status = 'in_progress' and t.accepted and not t.on_hold
        and t.budget_hours is not null and t.budget_started_at is null`,
    [eid],
  );
}

// The daily summary for one editor on one date — aggregated across every session
// that day (handles Start/End/Start). Completed = tasks marked done whose
// completion time falls inside any of that day's session windows. dueToday reuses
// My Day's "due today" definition (due_date == the workday) and dueTodayDone is
// how many of those are done — a separate figure from Completed, since work
// finished today is often due another day. Working hours run
// from the day's first start to its last end (null while a session is still open).
export async function summaryFor(orgId, editorId, date) {
  const { rows: sessions } = await pool.query(
    `select id, started_at as "startedAt", ended_at as "endedAt", auto_closed as "autoClosed"
       from eod_session where editor_id = $1 and org_id = $2 and date = $3
       order by started_at`,
    [editorId, orgId, date],
  );
  if (!sessions.length) {
    return { date, status: "not_started", startedAt: null, endedAt: null, groups: [], completedCount: 0, dueToday: 0, dueTodayDone: 0, tasks: [] };
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
  const sessionDays = new Set(sessions.map((s) => new Date(new Date(s.startedAt).getTime() + 330 * 60_000).toISOString().slice(0, 10)));
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
    tasks: await dayTasks(orgId, editorId, date),
  };
}

// The day's tasks for the End of Day window and report, each with its current
// status, channel and the note written for it that day. "The day's tasks" are
// the ones in that day's Start of Day (not the unticked ones), plus any that
// were finished, created, submitted for review or given a note that day — and,
// for today, whatever is in progress or in review right now.
async function dayTasks(orgId, editorId, date) {
  const { rows } = await pool.query(
    `with planned as (
       select (x->>'id')::uuid as id
         from sod_plan p, jsonb_array_elements(p.tasks) x
        where p.editor_id = $1 and p.org_id = $2 and p.date = $3 and coalesce(x->>'group', '') <> 'skipped'
     ), submitted as (
       select a.entity_id as id
         from activity a join app_user u on u.id = a.actor_id
        where u.editor_id = $1 and a.org_id = $2 and a.verb = 'review_requested' and a.entity_type = 'task'
          and (a.created_at at time zone 'Asia/Kolkata')::date = $3
     )
     select t.id, t.title, t.status, t.on_hold as "onHold", t.completed_at as "completedAt",
            cf.name as format, w.name as channel, n.note
       from task t
       left join task_content_format cf on cf.id = t.content_format_id
       left join workspace w on w.id = t.channel_id
       left join eod_task_note n on n.task_id = t.id and n.editor_id = $1 and n.date = $3
      where t.org_id = $2
        and (n.id is not null or (t.editor_id = $1 and (
              t.id in (select id from planned)
           or t.id in (select id from submitted)
           or (t.completed_at at time zone 'Asia/Kolkata')::date = $3
           or (t.created_at at time zone 'Asia/Kolkata')::date = $3
           or ($3::date = (now() at time zone 'Asia/Kolkata')::date and t.status in ('in_progress', 'review'))
        )))
      order by case t.status when 'done' then 0 when 'review' then 1 when 'in_progress' then 2 else 3 end, t.title`,
    [editorId, orgId, date],
  );
  return rows;
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

// Open a work session for this person — idempotent: the open one if there is
// one. { session, created }. Shared with Start day (routes/attendance.js).
export async function startSession(orgId, eid) {
  await closeStaleSessions();
  const open = await pool.query(
    `select id, date, started_at as "startedAt", ended_at as "endedAt"
       from eod_session where editor_id = $1 and ended_at is null limit 1`,
    [eid],
  );
  if (open.rows.length) return { session: open.rows[0], created: false };
  try {
    const { rows } = await pool.query(
      `insert into eod_session (org_id, editor_id, date, started_at)
       values ($1, $2, (now() at time zone 'Asia/Kolkata')::date, now())
       returning id, date, started_at as "startedAt", ended_at as "endedAt"`,
      [orgId, eid],
    );
    await resumeDayTimers(eid);
    return { session: rows[0], created: true };
  } catch (e) {
    // Lost a race to the partial-unique index — return whoever won.
    if (e.code === "23505") {
      const { rows } = await pool.query(
        `select id, date, started_at as "startedAt", ended_at as "endedAt"
           from eod_session where editor_id = $1 and ended_at is null limit 1`,
        [eid],
      );
      return { session: rows[0] ?? null, created: false };
    }
    throw e;
  }
}

// Close this person's open session and return it with the day's summary, or
// null when nothing was open. Also stamps the day's attendance check-out.
// Shared with End day (routes/attendance.js).
export async function endSession(orgId, eid) {
  const { rows } = await pool.query(
    `update eod_session set ended_at = now()
      where editor_id = $1 and ended_at is null
      returning id, date, started_at as "startedAt", ended_at as "endedAt"`,
    [eid],
  );
  if (!rows.length) return null;
  await pauseDayTimers(eid);
  if (await hasColumn("attendance", "id")) {
    await pool.query(
      `update attendance set check_out_at = now(), updated_at = now()
        where editor_id = $1 and date = (now() at time zone 'Asia/Kolkata')::date and check_out_at is null`,
      [eid],
    );
  }
  return { session: rows[0], summary: await summaryFor(orgId, eid, rows[0].date) };
}

// Start EOD — idempotent: returns the existing open session if there is one.
eodRouter.post("/eod/start", async (req, res, next) => {
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { session, created } = await startSession(req.orgId, eid);
    res.status(created ? 201 : 200).json({ session });
  } catch (err) { next(err); }
});

// End EOD — closes the open session and returns the day's summary.
eodRouter.patch("/eod/end", async (req, res, next) => {
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const ended = await endSession(req.orgId, eid);
    if (!ended) return res.status(400).json({ error: "You haven't started work, so there's nothing to end." });
    res.json(ended);
  } catch (err) { next(err); }
});

// Save the caller's End of Day notes for today's work day — one per task; an
// empty note removes it. Returns the refreshed day summary.
eodRouter.put("/eod/notes", async (req, res, next) => {
  const parsed = z.object({
    notes: z.array(z.object({ taskId: z.string().uuid(), note: z.string().max(2000) })).max(300),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Those notes couldn't be read." });
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.status(400).json({ error: "Your account isn't linked to a team member." });
    const { rows: s } = await pool.query(
      "select date from eod_session where editor_id = $1 and org_id = $2 and date = (now() at time zone 'Asia/Kolkata')::date limit 1", [eid, req.orgId],
    );
    if (!s.length) return res.status(400).json({ error: "Press Start Work first." });
    const date = s[0].date;
    // Only the caller's own tasks (or ones they already wrote a note on today).
    const allowed = new Set((await dayTasks(req.orgId, eid, date)).map((t) => t.id));
    const ids = parsed.data.notes.map((n) => n.taskId);
    const { rows: own } = await pool.query(
      "select id from task where org_id = $1 and editor_id = $2 and id = any($3::uuid[])", [req.orgId, eid, ids],
    );
    for (const r of own) allowed.add(r.id);
    for (const { taskId, note } of parsed.data.notes) {
      if (!allowed.has(taskId)) continue;
      const text = note.trim();
      if (text) {
        await pool.query(
          `insert into eod_task_note (org_id, editor_id, date, task_id, note) values ($1, $2, $3, $4, $5)
           on conflict (editor_id, date, task_id) do update set note = excluded.note, updated_at = now()`,
          [req.orgId, eid, date, taskId, text],
        );
      } else {
        await pool.query("delete from eod_task_note where editor_id = $1 and date = $2 and task_id = $3", [eid, date, taskId]);
      }
    }
    res.json({ summary: await summaryFor(req.orgId, eid, date) });
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

// My reports — your own work days, newest first: each day you started work or
// copied a Start of Day in the last ?days= (30 by default, at most 365), with
// the same figures the admin's Work Day page shows. Always yourself.
eodRouter.get("/eod/my-days", async (req, res, next) => {
  try {
    const eid = await callerEditorId(req);
    if (!eid) return res.json({ days: [], unlinked: true });
    const span = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    await closeStaleSessions();
    const { rows } = await pool.query(
      `with days as (
         select date from eod_session where editor_id = $1 and date > (now() at time zone 'Asia/Kolkata')::date - $2::int
         union
         select date from sod_plan where editor_id = $1 and date > (now() at time zone 'Asia/Kolkata')::date - $2::int
       )
       select to_char(d.date, 'YYYY-MM-DD') as date,
              coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)), 0)::int as "workedSeconds",
              coalesce(bool_or(s.auto_closed), false) as "autoClosed",
              (select p.submitted_at from sod_plan p where p.editor_id = $1 and p.date = d.date) as "planSubmittedAt",
              (select count(*)::int from sod_plan p, jsonb_array_elements(p.tasks) x
                 where p.editor_id = $1 and p.date = d.date and x->>'group' <> 'skipped') as "planCount",
              min(s.started_at) as "startedAt",
              max(s.ended_at)   as "endedAt",
              bool_or(s.ended_at is null) as "anyOpen",
              count(s.id)::int  as "sessions"
         from days d
         left join eod_session s on s.editor_id = $1 and s.date = d.date
        group by d.date
        order by d.date desc`,
      [eid, span],
    );
    const days = rows.map((r) => ({
      date: r.date,
      status: r.sessions === 0 ? "not_started" : (r.anyOpen ? "active" : "completed"),
      startedAt: r.startedAt,
      endedAt: r.anyOpen ? null : r.endedAt,
      sessions: r.sessions,
      workedSeconds: r.workedSeconds,
      autoClosed: r.autoClosed,
      planSubmittedAt: r.planSubmittedAt,
      planCount: r.planCount,
    }));
    res.json({ days });
  } catch (err) { next(err); }
});

// Admin oversight — every (non-admin) editor's EOD status for a date.
eodRouter.get("/eod/team", requireAdmin, async (req, res, next) => {
  try {
    const date = String(req.query.date || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)).slice(0, 10);
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
    // Settings › Attendance › Require Start of day off: work isn't gated.
    if (await hasColumn("org", "settings")) {
      const { rows: o } = await pool.query("select settings->'attendance'->'requireSod' as r from org where id = $1", [req.orgId]);
      if (o[0]?.r === false) return next();
    }
    await closeStaleSessions();
    const { rowCount } = await pool.query(
      "select 1 from eod_session where editor_id = $1 and ended_at is null limit 1",
      [eid],
    );
    if (!rowCount) return res.status(403).json({ error: "Start your day first — tap Start day on Home." });
    next();
  } catch (err) { next(err); }
}
