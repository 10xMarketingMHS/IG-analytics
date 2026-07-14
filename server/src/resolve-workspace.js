import { pool } from "./db.js";

// Short-lived membership cache. Every scoped request otherwise pays an extra
// round trip to the (remote) DB just to look up the caller's role. Roles change
// rarely, so a brief TTL is a safe, big win; writes to users clear it.
const TTL_MS = 30_000;
const membershipCache = new Map(); // `${uid}:${wsId}` -> { role, exp }

function cachedRole(uid, wsId) {
  const hit = membershipCache.get(`${uid}:${wsId}`);
  if (hit && hit.exp > Date.now()) return hit; // { role: string|null }
  return undefined;
}
function cacheRole(uid, wsId, role) {
  membershipCache.set(`${uid}:${wsId}`, { role, exp: Date.now() + TTL_MS });
}
export function clearMembershipCache() {
  membershipCache.clear();
}

// Which org a channel belongs to changes ~never, so cache it for the process.
const wsOrgCache = new Map(); // wsId -> orgId
async function orgForWorkspace(wsId) {
  if (wsOrgCache.has(wsId)) return wsOrgCache.get(wsId);
  const { rows } = await pool.query("select org_id from workspace where id = $1", [wsId]);
  const orgId = rows[0]?.org_id ?? null;
  wsOrgCache.set(wsId, orgId);
  return orgId;
}

// Resolves the active workspace for a request. The client sends the chosen
// workspace via the `X-Workspace-Id` header (the workspace switcher). We
// verify the authenticated user is a member of it; otherwise fall back to
// their oldest workspace. Sets req.workspaceId and req.role.
export async function resolveWorkspace(req, res, next) {
  try {
    const uid = req.user.sub;
    const requested = req.get("X-Workspace-Id");
    let workspaceId = null;
    let role = null;

    if (requested) {
      let entry = cachedRole(uid, requested);
      if (entry === undefined) {
        const { rows } = await pool.query(
          "select role from membership where workspace_id = $1 and user_id = $2",
          [requested, uid],
        );
        entry = { role: rows[0]?.role ?? null };
        cacheRole(uid, requested, entry.role);
      }
      if (entry.role) {
        workspaceId = requested;
        role = entry.role;
      }
    }

    if (!workspaceId) {
      const { rows } = await pool.query(
        `select w.id, m.role from workspace w
         join membership m on m.workspace_id = w.id
         where m.user_id = $1
         order by w.created_at asc
         limit 1`,
        [uid],
      );
      workspaceId = rows[0]?.id ?? null;
      role = rows[0]?.role ?? null;
    }

    if (!workspaceId) {
      return res.status(404).json({ error: "No workspace available" });
    }

    req.workspaceId = workspaceId;
    req.role = role;
    // Org context for shared-team resources (editors, tasks).
    req.orgId = await orgForWorkspace(workspaceId);
    next();
  } catch (err) {
    next(err);
  }
}

// Gate write/delete actions to workspace admins. Must run after
// resolveWorkspace (which sets req.role).
export function requireAdmin(req, res, next) {
  if (req.role !== "admin") {
    return res.status(403).json({ error: "Admins only" });
  }
  next();
}

// Gate content writes to admins & editors (viewers are read-only).
export function requireEditor(req, res, next) {
  if (req.role !== "admin" && req.role !== "editor") {
    return res.status(403).json({ error: "You have read-only (viewer) access." });
  }
  next();
}
