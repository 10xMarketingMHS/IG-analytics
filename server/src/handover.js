import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { logActivity } from "./activity.js";
import { closingFor, istAt, istYmd, positionKey, readSettings } from "./attendance.js";

// Hand over — someone passes their own task to a teammate (the task's panel on
// the Task Board). It stays theirs, its timer paused, until the teammate
// accepts (it becomes theirs, and so do its points) or declines (it stays).
// Nobody answering climbs the team: at the close of the work day it was
// offered the Team Leads are warned; at the next close it reaches the Asst.
// Managers; at the one after, the Managers. Whoever it has reached can move it
// to someone. Like attendance, the climb is applied the first time Pulse is
// used after each close (syncHandovers). See 20261026120000_task_handover.sql.

export const handoverReady = () => hasColumn("task_handover", "id");

const LEVEL_KEYS = [null, "teamLead", "asstManager", "manager"];
export const LEVEL_LABEL = [null, "Team Leads", "Asst. Managers", "Managers"];

const addDay = (ymd) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// The next `n` office closings after a moment (Sundays and days off skipped).
export function closingsAfter(cal, from, n = 3) {
  const out = [];
  const fromMs = new Date(from).getTime();
  let ymd = istYmd(from);
  for (let i = 0; out.length < n && i < 21; i++, ymd = addDay(ymd)) {
    const close = closingFor(cal, ymd);
    if (!close) continue;
    const at = istAt(ymd, close);
    if (at.getTime() > fromMs) out.push(at);
  }
  return out;
}

// Who can take a task: active team members with an active login who can work
// (editor or admin), with their roster position.
export async function handoverPeople(orgId) {
  const { rows } = await pool.query(
    `select e.id, e.name, e.designation, e.image_url as "imageUrl",
            bool_or(m.role = 'admin') as "isAdmin",
            bool_or(m.role in ('admin', 'editor')) as "canWork"
       from editor e
       join app_user u on u.editor_id = e.id and u.active
       join membership m on m.user_id = u.id
       join workspace w on w.id = m.workspace_id and w.org_id = e.org_id
      where e.org_id = $1 and e.active
      group by e.id
      order by e.name`,
    [orgId],
  );
  return rows.filter((r) => r.canWork);
}

// Team Leads and Managers hear about every hand-over offered and every one
// accepted (a notice only; moving it on is for when it climbs).
export async function leadsAndManagers(orgId) {
  return (await handoverPeople(orgId))
    .filter((p) => ["teamLead", "manager"].includes(positionKey(p.designation)))
    .map((p) => p.id);
}

// Who a hand-over reaches at a level: that position's people, or, when nobody
// holds it, the next one up, then the admins. Never the two people in it.
async function targetsFor(orgId, level, skip) {
  const people = (await handoverPeople(orgId)).filter((p) => !skip.includes(p.id));
  for (let l = level; l <= 3; l++) {
    const at = people.filter((p) => positionKey(p.designation) === LEVEL_KEYS[l]);
    if (at.length) return at.map((p) => p.id);
  }
  return people.filter((p) => p.isAdmin).map((p) => p.id);
}

const lastSync = new Map();
export async function syncHandovers(orgId) {
  if (!orgId || !(await handoverReady())) return;
  const now = Date.now();
  if (now - (lastSync.get(orgId) ?? 0) < 60_000) return;
  lastSync.set(orgId, now);
  try {
    const { rows } = await pool.query(
      `select h.id, h.task_id, h.from_editor_id, h.to_editor_id, h.level, h.reached, h.created_at,
              t.title, t.channel_id, ef.name as from_name, et.name as to_name
         from task_handover h
         join task t on t.id = h.task_id
         left join editor ef on ef.id = h.from_editor_id
         left join editor et on et.id = h.to_editor_id
        where h.org_id = $1 and h.status = 'pending' and h.level < 3`,
      [orgId],
    );
    if (!rows.length) return;
    const { cal } = await readSettings(orgId);
    for (const h of rows) {
      const due = closingsAfter(cal, h.created_at).filter((c) => c.getTime() <= now).length;
      if (due <= h.level) continue;
      const before = h.reached ?? [];
      const ids = await targetsFor(orgId, due, [h.from_editor_id, h.to_editor_id].filter(Boolean));
      const fresh = ids.filter((id) => !before.includes(id));
      await pool.query(
        "update task_handover set level = $2, reached = $3::uuid[], escalated_at = now() where id = $1",
        [h.id, due, [...new Set([...before, ...ids])]],
      );
      if (!fresh.length) continue;
      const who = h.to_name ?? "A teammate";
      await logActivity({
        orgId, actorId: null, verb: "handover_escalated", entityType: "task", entityId: h.task_id, channelId: h.channel_id,
        summary: due === 1
          ? `${who} didn't accept “${h.title}” from ${h.from_name ?? "a teammate"} today`
          : `${who} still hasn't accepted “${h.title}” from ${h.from_name ?? "a teammate"} after ${due} work days. Move it to someone`,
        meta: { handoverId: h.id, level: due, notifyEditorIds: fresh },
      });
    }
  } catch (err) {
    console.error("syncHandovers failed:", err.message);
  }
}

// While a hand-over waits, the owner's running timer stops (as Hold does).
// True when it stopped one.
export async function pauseForHandover(task, userId) {
  if (task.status !== "in_progress" || !task.accepted || task.on_hold || !task.budget_started_at || task.budget_hours == null) return false;
  const elapsed = Math.max(0, (Date.now() - new Date(task.budget_started_at).getTime()) / 1000);
  await pool.query(
    "update task set on_hold = true, held_by = $2, budget_used_seconds = $3, budget_started_at = null where id = $1",
    [task.id, userId, Number(task.budget_used_seconds ?? 0) + elapsed],
  );
  return true;
}

// Declined or called off: the owner's timer runs on from where it stopped.
export async function resumeAfterHandover(taskId) {
  await pool.query(
    `update task
        set on_hold = false, held_by = null,
            budget_started_at = case when budget_hours is null then null
                                     else now() - make_interval(secs => coalesce(budget_used_seconds, 0)) end,
            budget_used_seconds = 0
      where id = $1 and on_hold`,
    [taskId],
  );
}

// The task changed hands another way, or moved on to Review or Completed:
// a waiting hand-over is over.
export async function closePendingHandovers(taskId) {
  if (!(await handoverReady())) return;
  await pool.query(
    "update task_handover set status = 'cancelled', answered_at = now() where task_id = $1 and status = 'pending'",
    [taskId],
  );
}
