import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Super Admin sits above Admin — a flag on the login (app_user.is_super_admin)
// on top of the admin role, so every existing admin check still holds. Until
// anyone here is a Super Admin (or before the database change is applied)
// every admin counts as one, so nobody is locked out.
export async function superState(workspaceId) {
  if (!(await hasColumn("app_user", "is_super_admin"))) return { on: false, count: 0 };
  const { rows } = await pool.query(
    `select count(*)::int c from membership m join app_user u on u.id = m.user_id
      where m.workspace_id = $1 and m.role = 'admin' and u.is_super_admin`,
    [workspaceId],
  );
  return { on: true, count: rows[0].c };
}
export async function isSuperUser(userId, st) {
  if (!st.on || st.count === 0) return true;
  const { rows } = await pool.query("select is_super_admin from app_user where id = $1", [userId]);
  return !!rows[0]?.is_super_admin;
}
