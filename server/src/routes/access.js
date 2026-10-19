import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { PERMISSION_KEYS, activeGrants, assignFormats, requirePermission, reviewAccess } from "../permissions.js";
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
    const review = await reviewAccess(req.orgId, userId);
    const formats = await assignFormats(req.orgId, userId);
    res.json({ permissions: await activeGrants(req.orgId, userId), reviewScope: review.scope, assignScope: formats ? { formats } : null });
  } catch (err) {
    next(err);
  }
});

// GET /access/review-scope/me — the caller's own review access, so the Task
// Board can show approve / send-back only on the tasks they may resolve. Open
// to every signed-in member; it only ever describes the caller.
accessRouter.get("/access/review-scope/me", async (req, res, next) => {
  try {
    const formats = await assignFormats(req.orgId, req.user.sub);
    res.json({ ...(await reviewAccess(req.orgId, req.user.sub)), assignScope: formats ? { formats } : null });
  } catch (err) {
    next(err);
  }
});

const ReviewScopeSchema = z.union([
  z.object({
    editors: z.array(z.object({
      editorId: z.string().uuid(),
      taskIds: z.array(z.string().uuid()).nullable(),
    })),
  }),
  // Content types: every task of these content formats (e.g. all Carousels).
  z.object({ formats: z.array(z.string().uuid()).min(1) }),
]);
const AssignScopeSchema = z.object({ formats: z.array(z.string().uuid()).min(1) });

const SaveSchema = z.object({
  userId: z.string().uuid(),
  // A desired-state map; only known keys are honored, unknown ones ignored.
  permissions: z.record(z.string(), z.boolean()),
  // Narrows resolve_tasks: null/omitted = everyone, otherwise only these
  // people/tasks. Ignored unless resolve_tasks is being granted.
  reviewScope: ReviewScopeSchema.nullable().optional(),
  // Narrows assign_tasks to some content types: null/omitted = any task.
  assignScope: AssignScopeSchema.nullable().optional(),
});

// PUT /access/grants — apply a user's desired permission state. New permissions
// insert a grant (granted_by/granted_at set); un-ticked ones that were active
// get soft-revoked (revoked_at set), never hard-deleted — history stays intact.
accessRouter.put("/access/grants", manageAccess, async (req, res, next) => {
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid grant payload." });
  const { userId, permissions, reviewScope, assignScope } = parsed.data;
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
      const want = permissions[key] === true;
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
    if (permissions.resolve_tasks === true) {
      await pool.query(
        "update user_permission_grant set scope=$4 where org_id=$1 and user_id=$2 and permission_key=$3 and revoked_at is null",
        [req.orgId, userId, "resolve_tasks", reviewScope ? JSON.stringify(reviewScope) : null],
      );
    }
    if (permissions.assign_tasks === true) {
      await pool.query(
        "update user_permission_grant set scope=$4 where org_id=$1 and user_id=$2 and permission_key=$3 and revoked_at is null",
        [req.orgId, userId, "assign_tasks", assignScope ? JSON.stringify(assignScope) : null],
      );
    }
    res.json({ ok: true, permissions: await activeGrants(req.orgId, userId), reviewScope: reviewScope ?? null, assignScope: assignScope ?? null });
  } catch (err) {
    next(err);
  }
});
