import { pool } from "./db.js";

// Access — per-user permission grants (see the Settings → Access UI and the
// user_permission_grant table). An ADDITIVE layer on top of roles: a grant
// extends what a specific user can do, always self-scoped to their own data.
//
// The curated, hardcoded set of permission keys — not a dynamic registry.
// Adding a new named permission means editing this list and wiring its own
// route logic. Grants are meaningless for admins (they can do everything
// already), so the Access UI never offers them for admin users.
//
// Two shapes of grant live here:
//  - SELF-SCOPED (create_post, goal_setting_access): only ever extend what the
//    grantee can do to their OWN data — the route applies the scoping.
//  - ADMIN-CAPABILITY (the rest): "act as admin for this one feature". A grantee
//    gets the same cross-user/org power an admin has for that capability. These
//    were opted into explicitly; they are NOT self-scoped.
export const PERMISSION_KEYS = [
  "create_post",         // self-scoped: create posts assigned only to self
  "goal_setting_access", // self-scoped: read-only view of own goals
  "task_settings",       // admin cap: content formats, points, time budgets
  "channels",            // admin cap: channels & integrations
  "content_taxonomy",    // admin cap: pillars/avatars/content types/formats
  "access_manage",       // admin cap: grant permissions to other users
  "assign_tasks",        // admin cap: assign tasks to other editors
  "resolve_tasks",       // admin cap: approve / send back tasks in review
  "hold_tasks",          // admin cap: hold or resume anyone's task
  "edit_goals",          // admin cap: set editors' goals & capacity
  "discipline",          // admin cap: award discipline ratings
];

// The active permission keys held by a user in an org, read fresh from the DB.
// NEVER cache this in the JWT: a grant must take effect immediately, without
// waiting for the grantee's next login.
export async function activeGrants(orgId, userId) {
  const { rows } = await pool.query(
    "select permission_key from user_permission_grant where org_id=$1 and user_id=$2 and revoked_at is null",
    [orgId, userId],
  );
  return rows.map((r) => r.permission_key);
}

export async function hasActiveGrant(orgId, userId, key) {
  const { rows } = await pool.query(
    "select 1 from user_permission_grant where org_id=$1 and user_id=$2 and permission_key=$3 and revoked_at is null limit 1",
    [orgId, userId, key],
  );
  return rows.length > 0;
}

// Middleware: allow if the caller is an admin, OR holds an active grant for
// `key`. Composes WITH the role system rather than replacing it — pass an
// `alsoAllow` set of roles that should still pass without a grant (e.g. posts
// are normally open to editors). When the caller passes purely on the grant
// (not on a role), req.viaGrant[key] is set true so the route can apply that
// permission's OWN self-scoping — this middleware only answers "does this user
// have this permission at all", never the self-scoping half.
// `key` may be a single permission key or an array — the caller passes if they
// hold ANY of them (e.g. the goals view opens to goal_setting_access, edit_goals
// or discipline). Every held key is flagged on req.viaGrant so a route can tell
// exactly which grant let them in (self-scoping vs full access hinge on that).
export function requirePermission(key, { alsoAllow = [], message } = {}) {
  const keys = Array.isArray(key) ? key : [key];
  return async (req, res, next) => {
    try {
      if (req.role === "admin" || alsoAllow.includes(req.role)) return next();
      const { rows } = await pool.query(
        "select permission_key from user_permission_grant where org_id=$1 and user_id=$2 and permission_key = any($3) and revoked_at is null",
        [req.orgId, req.user.sub, keys],
      );
      if (rows.length) {
        req.viaGrant ??= {};
        for (const r of rows) req.viaGrant[r.permission_key] = true;
        return next();
      }
      return res.status(403).json({ error: message ?? "You don't have access to this." });
    } catch (err) {
      next(err);
    }
  };
}
