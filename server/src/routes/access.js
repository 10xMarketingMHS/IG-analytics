import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";
import { PERMISSION_KEYS, activeGrants } from "../permissions.js";

// Settings → Access — admin-only management of per-user permission grants.
// The user picker is served by the existing GET /users (workspace members);
// these two routes read and write one user's grants for the current org.
export const accessRouter = Router();

// GET /access/grants?userId= — the active permission keys held by one user,
// so the Access checklist can show current state (checked = active grant).
accessRouter.get("/access/grants", requireAdmin, async (req, res, next) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId is required." });
  try {
    res.json({ permissions: await activeGrants(req.orgId, userId) });
  } catch (err) {
    next(err);
  }
});

const SaveSchema = z.object({
  userId: z.string().uuid(),
  // A desired-state map; only known keys are honored, unknown ones ignored.
  permissions: z.record(z.string(), z.boolean()),
});

// PUT /access/grants — apply a user's desired permission state. New permissions
// insert a grant (granted_by/granted_at set); un-ticked ones that were active
// get soft-revoked (revoked_at set), never hard-deleted — history stays intact.
accessRouter.put("/access/grants", requireAdmin, async (req, res, next) => {
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid grant payload." });
  const { userId, permissions } = parsed.data;
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
    res.json({ ok: true, permissions: await activeGrants(req.orgId, userId) });
  } catch (err) {
    next(err);
  }
});
