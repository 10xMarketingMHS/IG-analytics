import { Router } from "express";
import { pool } from "../db.js";
import { homeRoleOf } from "../attendance.js";
import { hasActiveGrant, reviewAccess } from "../permissions.js";

export const activityRouter = Router();

// Recent activity, newest first. Optional ?channel=<id> filter and ?limit=
// (capped). Joins the actor's name for display.
//
// Admins see the whole org. Everyone else gets a personal feed: events on tasks
// assigned to them (including one that was deleted or moved to someone else),
// things they did themselves, and their own joining the team — plus,
// for resolve_tasks grantees, tasks submitted for review that fall inside their
// review scope — and, for assigners, tasks they assigned that went into review.
// Other people's tasks and arrivals, published posts and channel changes are
// left out.
activityRouter.get("/activity", async (req, res, next) => {
  try {
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
      // Team leads and managers (by position) get everyone's attendance notices.
      const leadsTeam = homeRoleOf(me[0]?.designation, false) !== "editor";
      const review = await reviewAccess(req.orgId, req.user.sub);
      // Unscoped grant → every review request. Scoped → only requests on the
      // people (all their tasks) or the individual tasks the scope names.
      const reviewAll = review.granted && !review.scope;
      const scoped = review.granted && review.scope ? review.scope.editors ?? [] : [];
      const scopeEditors = scoped.filter((e) => e.taskIds == null).map((e) => e.editorId);
      const scopeTasks = scoped.flatMap((e) => e.taskIds ?? []);
      const assigner = await hasActiveGrant(req.orgId, req.user.sub, "assign_tasks");
      params.push(req.user.sub, me[0]?.editor_id ?? null, reviewAll, scopeEditors, scopeTasks, assigner);
      const [uid, eid, resolve, sEds, sTasks, asg] =
        [params.length - 5, params.length - 4, params.length - 3, params.length - 2, params.length - 1, params.length];
      where += ` and (
        a.actor_id = $${uid}
        or (a.verb = 'editor_added' and a.entity_id = $${eid}::uuid)
        or (a.verb like 'attendance_%' and (a.entity_id = $${eid}::uuid${leadsTeam ? " or true" : ""}))
        or (a.verb = 'deleted' and a.meta->>'editorId' = $${eid}::text)
        or (a.verb = 'assigned' and a.meta->>'fromEditorId' = $${eid}::text)
        or (a.entity_type = 'task' and exists (
              select 1 from task t where t.id = a.entity_id and t.editor_id = $${eid}::uuid))
        or (a.verb = 'review_requested' and (
              $${resolve}::boolean
              or exists (select 1 from task t where t.id = a.entity_id
                          and (t.editor_id = any($${sEds}::uuid[]) or t.id = any($${sTasks}::uuid[])
                               or ($${asg}::boolean and t.assigned_by = $${uid}::uuid)))))
      )`;
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
