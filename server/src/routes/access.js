import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { PERMISSION_KEYS, activeGrants, assignLimits, hasActiveGrant, requirePermission } from "../permissions.js";
import { rankOf } from "../hierarchy.js";

// Resolve reviews is retired: who reviews a task follows one rule
// (../review-route.js), so Access no longer hands it out, and a save clears it.
const RETIRED = new Set(["resolve_tasks"]);
import { isSuperHere } from "../super-admin.js";

// Settings → Access — the Super Admin's management of per-user permission
// grants (or someone the Super Admin gave access_manage; an admin who isn't
// the Super Admin can't). The user picker is served by the existing GET /users
// (workspace members); these two routes read and write one user's grants.
export const accessRouter = Router();

const viaGrant = requirePermission("access_manage");
async function manageAccess(req, res, next) {
  try {
    if (req.role !== "admin") return viaGrant(req, res, next);
    if (await isSuperHere(req)) return next();
    return res.status(403).json({ error: "Only a Super Admin can change who has extra access." });
  } catch (err) {
    next(err);
  }
}

// GET /access/grants?userId= — the active permission keys held by one user,
// so the Access checklist can show current state (checked = active grant).
accessRouter.get("/access/grants", manageAccess, async (req, res, next) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId is required." });
  try {
    const [assignScope, permissions] = await Promise.all([assignLimits(req.orgId, userId), activeGrants(req.orgId, userId)]);
    res.json({ permissions: permissions.filter((k) => !RETIRED.has(k)), assignScope });
  } catch (err) {
    next(err);
  }
});

// GET /access/review-scope/me — about the caller only: whether any task can
// come to them for review (they assign work, or they're a Team Lead or above;
// each task says can_review itself), and any limit on their Assign tasks.
accessRouter.get("/access/review-scope/me", async (req, res, next) => {
  try {
    const [assignScope, assigner, me] = await Promise.all([
      assignLimits(req.orgId, req.user.sub),
      hasActiveGrant(req.orgId, req.user.sub, "assign_tasks"),
      pool.query("select e.designation from app_user u left join editor e on e.id = u.editor_id where u.id = $1", [req.user.sub]),
    ]);
    const admin = req.role === "admin";
    const reviewer = admin || assigner || rankOf(me.rows[0]?.designation, admin) <= 2;
    res.json({ reviewer, assignScope });
  } catch (err) {
    next(err);
  }
});

// Assign tasks limited to some content types, some people, or both.
const AssignScopeSchema = z.object({
  formats: z.array(z.string().uuid()).min(1).optional(),
  editors: z.array(z.string().uuid()).min(1).optional(),
}).refine((s) => s.formats || s.editors);

const SaveSchema = z.object({
  userId: z.string().uuid(),
  // A desired-state map; only known keys are honored, unknown ones ignored.
  permissions: z.record(z.string(), z.boolean()),
  // Narrows assign_tasks to some content types and/or people: null/omitted = any.
  assignScope: AssignScopeSchema.nullable().optional(),
});

// PUT /access/grants — apply a user's desired permission state. New permissions
// insert a grant (granted_by/granted_at set); un-ticked ones that were active
// get soft-revoked (revoked_at set), never hard-deleted — history stays intact.
accessRouter.put("/access/grants", manageAccess, async (req, res, next) => {
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid grant payload." });
  const { userId, permissions, assignScope } = parsed.data;
  // never your own: someone given Access management could otherwise give
  // themselves every other grant
  if (userId === req.user.sub) return res.status(403).json({ error: "You can't change your own access. The Super Admin does." });
  try {
    // Target must be a member of this workspace, and not an admin — grants are
    // meaningless for admins (they already have everything).
    const { rows: mem } = await pool.query(
      "select role from membership where workspace_id=$1 and user_id=$2",
      [req.workspaceId, userId],
    );
    if (!mem.length) return res.status(404).json({ error: "That user isn't in this workspace." });
    if (mem[0].role === "admin") return res.status(400).json({ error: "Admins already have full access — nothing to grant." });

    const current = new Set(await activeGrants(req.orgId, userId));
    for (const key of PERMISSION_KEYS) {
      const want = permissions[key] === true && !RETIRED.has(key);
      const have = current.has(key);
      if (want && !have) {
        await pool.query(
          "insert into user_permission_grant (org_id, user_id, permission_key, granted_by) values ($1,$2,$3,$4)",
          [req.orgId, userId, key, req.user.sub],
        );
      } else if (!want && have) {
        await pool.query(
          "update user_permission_grant set revoked_at=now() where org_id=$1 and user_id=$2 and permission_key=$3 and revoked_at is null",
          [req.orgId, userId, key],
        );
      }
    }
    if (permissions.assign_tasks === true) {
      await pool.query(
        "update user_permission_grant set scope=$4 where org_id=$1 and user_id=$2 and permission_key=$3 and revoked_at is null",
        [req.orgId, userId, "assign_tasks", assignScope ? JSON.stringify(assignScope) : null],
      );
    }
    res.json({ ok: true, permissions: (await activeGrants(req.orgId, userId)).filter((k) => !RETIRED.has(k)), assignScope: assignScope ?? null });
  } catch (err) {
    next(err);
  }
});
