import { pool } from "./db.js";
import { isOrgAdmin } from "./permissions.js";
import { positionKey } from "./attendance.js";

// The team's hierarchy by position: Manager › Asst. Manager › Team Lead ›
// Editor › Viewer (Team › Roster). Nobody sees the tasks of someone above
// them — an editor doesn't see a team lead's or a manager's tasks. Admins see
// everything. Lower number = more senior.
const RANK = { manager: 0, asstManager: 1, teamLead: 2 };
export function rankOf(designation, isAdmin) {
  const k = positionKey(designation);
  if (k) return RANK[k];
  const p = String(designation || "").trim().toLowerCase();
  if (p === "viewer") return 4;
  // An admin with no position, or an older title, sits at the top.
  if (isAdmin && p !== "editor") return 0;
  return 3;
}

// Every team member's rank in the org.
export async function editorRanks(orgId) {
  const { rows } = await pool.query(
    `select e.id, e.designation,
            exists (select 1 from app_user u join membership m on m.user_id = u.id
                     where u.editor_id = e.id and m.role = 'admin') as "isAdmin"
       from editor e where e.org_id = $1`,
    [orgId],
  );
  return new Map(rows.map((r) => [r.id, rankOf(r.designation, r.isAdmin)]));
}

// Who's asking: admins see all; anyone else gets their rank.
export async function taskViewer(req) {
  const admin = req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
  const { rows } = await pool.query(
    "select u.editor_id, e.designation from app_user u left join editor e on e.id = u.editor_id where u.id = $1",
    [req.user.sub],
  );
  return { admin, userId: req.user.sub, editorId: rows[0]?.editor_id ?? null, rank: rankOf(rows[0]?.designation, false) };
}

// May this person see that task? Their own, ones they created or assigned,
// unassigned ones, and anyone's at their level or below.
export function canSeeTask(viewer, ranks, t) {
  if (viewer.admin) return true;
  if (!t.editor_id || t.editor_id === viewer.editorId) return true;
  if (t.created_by === viewer.userId || t.assigned_by === viewer.userId) return true;
  return (ranks.get(t.editor_id) ?? 3) >= viewer.rank;
}

// For the routes on one task (reviews, subtasks, comments): true when the
// caller may see it (or it doesn't exist — the route says so itself).
export async function mayOpenTask(req, taskId) {
  const viewer = await taskViewer(req);
  if (viewer.admin) return true;
  const { rows } = await pool.query("select editor_id, created_by, assigned_by from task where id = $1 and org_id = $2", [taskId, req.orgId]);
  if (!rows.length) return true;
  return canSeeTask(viewer, await editorRanks(req.orgId), rows[0]);
}
