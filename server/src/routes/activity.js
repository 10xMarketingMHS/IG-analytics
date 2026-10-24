import { Router } from "express";
import { pool } from "../db.js";
import { callerScope } from "../attendance.js";
import { hasActiveGrant } from "../permissions.js";
import { syncReviewCopies } from "../review-route.js";
import { syncHandovers } from "../handover.js";

export const activityRouter = Router();

// Recent activity, newest first. Optional ?channel=<id> filter and ?limit=
// (capped). Joins the actor's name for display.
//
// Admins see the whole org. Everyone else gets a personal feed: events on tasks
// assigned to them (including one that was deleted or moved to someone else),
// things they did themselves, and their own joining the team — plus review
// notices meant for them (meta.notifyUserIds: whoever reviews the task, and
// the Managers' copy after 24 hours; see ../review-route.js).
// Other people's tasks and arrivals, published posts and channel changes are
// left out. Hand-over notices go to the people they name (meta.notifyEditorIds).
activityRouter.get("/activity", async (req, res, next) => {
  try {
    // an unanswered hand-over climbs at each office close (../handover.js);
    // checked at most once a minute, in the background (shows on the next look)
    syncHandovers(req.orgId).catch(() => {});
    // a task waiting 24 hours for a Team Lead: the Managers get a copy (same pacing)
    syncReviewCopies(req.orgId).catch(() => {});
    const params = [req.orgId];
    let where = "a.org_id = $1";
    if (req.query.channel && req.query.channel !== "all") {
      params.push(req.query.channel);
      where += ` and a.channel_id = $${params.length}`;
    }
    if (req.role !== "admin") {
      const { rows: me } = await pool.query(
        "select u.editor_id, e.designation from app_user u left join editor e on e.id = u.editor_id where u.id = $1", [req.user.sub],
      );
      // Whoever may see the team's attendance (Settings › Attendance) gets
      // everyone's attendance notices.
      const leadsTeam = (await callerScope(req)).scope === "all";
      const assigner = await hasActiveGrant(req.orgId, req.user.sub, "assign_tasks");
      params.push(req.user.sub, me[0]?.editor_id ?? null, assigner);
      const [uid, eid, asg] = [params.length - 2, params.length - 1, params.length];
      where += ` and (
        a.actor_id = $${uid}
        or (a.verb = 'editor_added' and a.entity_id = $${eid}::uuid)
        or (a.verb like 'attendance_%' and (a.entity_id = $${eid}::uuid${leadsTeam ? " or true" : ""}))
        or (a.verb = 'deleted' and a.meta->>'editorId' = $${eid}::text)
        or (a.verb = 'assigned' and a.meta->>'fromEditorId' = $${eid}::text)
        or (a.verb like 'handover_%' and coalesce(a.meta->'notifyEditorIds', '[]'::jsonb) ? ($${eid}::uuid)::text)
        or (a.entity_type = 'task' and exists (
              select 1 from task t where t.id = a.entity_id and t.editor_id = $${eid}::uuid))
        or (a.verb in ('review_requested', 'review_copied') and (
              coalesce(a.meta->'notifyUserIds', '[]'::jsonb) ? ($${uid}::uuid)::text
              -- older notices (before they named their reviewers): the assigner
              or (a.meta->'notifyUserIds' is null and $${asg}::boolean and exists (
                    select 1 from task t where t.id = a.entity_id and t.assigned_by = $${uid}::uuid))))
      )`;
    } else {
      // An admin sees the whole org, except review notices meant for someone
      // else: a review goes to its reviewers (../review-route.js), not to every
      // admin. Their own tasks' and their own actions' notices stay.
      const { rows: me } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
      params.push(req.user.sub, me[0]?.editor_id ?? null);
      const [uid, eid] = [params.length - 1, params.length];
      where += ` and not (
        a.verb in ('review_requested', 'review_copied') and a.meta ? 'notifyUserIds'
        and not (a.meta->'notifyUserIds' ? ($${uid}::uuid)::text)
        and a.actor_id is distinct from $${uid}::uuid
        and not exists (select 1 from task t where t.id = a.entity_id and t.editor_id = $${eid}::uuid)
      )`;
    }
    // after=<time>: only what's newer (the bell's check every half minute — most
    // often nothing at all)
    if (req.query.after && !Number.isNaN(Date.parse(String(req.query.after)))) {
      params.push(String(req.query.after));
      // to the millisecond, as the app has it (stored times carry microseconds)
      where += ` and date_trunc('milliseconds', a.created_at) > $${params.length}::timestamptz`;
    }
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    params.push(limit);
    const { rows } = await pool.query(
      `select a.id, a.verb, a.entity_type, a.entity_id, a.channel_id, a.actor_id,
              a.summary, a.meta, a.created_at,
              coalesce(u.name, u.email) as actor_name,
              w.name as channel_name
         from activity a
         left join app_user u on u.id = a.actor_id
         left join workspace w on w.id = a.channel_id
        where ${where}
        order by a.created_at desc
        limit $${params.length}`,
      params,
    );
    res.json({ activity: rows });
  } catch (err) {
    next(err);
  }
});
