import { pool } from "./db.js";

// Access — per-user permission grants (see the Settings → Access UI and the
// user_permission_grant table). An ADDITIVE layer on top of roles: a grant
// extends what a specific user can do, always self-scoped to their own data.
//
// The curated, hardcoded set of permission keys — not a dynamic registry.
// Adding a new named permission means editing this list and wiring its own
// route logic + self-scoping. Grants are meaningless for admins (they can do
// everything already), so the Access UI never offers them for admin users.
export const PERMISSION_KEYS = ["create_post", "goal_setting_access"];

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
export function requirePermission(key, { alsoAllow = [], message } = {}) {
  return async (req, res, next) => {
    try {
      if (req.role === "admin" || alsoAllow.includes(req.role)) return next();
      if (await hasActiveGrant(req.orgId, req.user.sub, key)) {
        (req.viaGrant ??= {})[key] = true;
        return next();
      }
      return res.status(403).json({ error: message ?? "You don't have access to this." });
    } catch (err) {
      next(err);
    }
  };
}
