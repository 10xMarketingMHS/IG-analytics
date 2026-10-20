import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Super Admin sits above Admin — a flag on the login (app_user.is_super_admin)
// on top of the admin role, so every existing admin check still holds. Until
// anyone in the organisation is a Super Admin (or before the database change is
// applied) every admin counts as one, so nobody is locked out. Counted across
// every channel of the org, never one channel: a channel an admin makes for
// themselves has no Super Admin in it, and must not make them one.
export async function superState(workspaceId) {
  if (!(await hasColumn("app_user", "is_super_admin"))) return { on: false, count: 0 };
  const { rows } = await pool.query(
    `select count(distinct u.id)::int c
       from membership m
       join workspace w on w.id = m.workspace_id
       join app_user u on u.id = m.user_id
      where m.role = 'admin' and u.is_super_admin
        and (w.org_id = (select org_id from workspace where id = $1) or m.workspace_id = $1)`,
    [workspaceId],
  );
  return { on: true, count: rows[0].c };
}
export async function isSuperUser(userId, st) {
  if (!st.on || st.count === 0) return true;
  const { rows } = await pool.query("select is_super_admin from app_user where id = $1", [userId]);
  return !!rows[0]?.is_super_admin;
}

// Is the person making this request the Super Admin here? An admin role on
// this workspace, plus the flag (or, before anyone has it, any admin).
export async function isSuperHere(req) {
  if (req.role !== "admin") return false;
  return isSuperUser(req.user.sub, await superState(req.workspaceId));
}

// Settings only the Super Admin changes: the work calendar, task points,
// attendance penalties, the scoring bands and Access. Admins still see them.
export const SUPER_ONLY_MSG = "Only a Super Admin can change this.";
export function requireSuper(message = SUPER_ONLY_MSG) {
  return async (req, res, next) => {
    try {
      if (await isSuperHere(req)) return next();
      return res.status(403).json({ error: message });
    } catch (err) {
      next(err);
    }
  };
}
