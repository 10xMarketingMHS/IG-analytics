import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db.js";
import { config } from "../config.js";
import { requireAdmin, clearMembershipCache } from "../resolve-workspace.js";
import { requirePermission } from "../permissions.js";
import { logActivity } from "../activity.js";
import { hasColumn } from "../schema-flags.js";
import { superState, isSuperUser } from "../super-admin.js";

export const usersRouter = Router();

const ROLES = ["admin", "editor", "viewer"];

// Super Admin (super-admin.js): only a Super Admin can make someone an admin,
// or change, reset, deactivate or remove an admin or Super Admin. The
// workspace always keeps at least one.
const SUPER_ONLY = "Only a Super Admin can change admins.";
const LAST_SUPER = "This is the only Super Admin — make someone else Super Admin first.";

// Everything here is admin-only — requireAdmin is applied per-route, not
// router-wide. A router-level `.use(requireAdmin)` would 403 every request
// that reaches this router before Express even checks whether one of its own
// paths matches, silently blocking routers mounted after it too (activity,
// integrations) for non-admins.

// List the members of the active workspace with their role.
// Readable by admins and by access_manage grantees (they need the member list
// to populate the Access picker). Mutations below stay admin-only (Team).
usersRouter.get("/users", requirePermission("access_manage"), async (req, res, next) => {
  try {
    const superCol = (await hasColumn("app_user", "is_super_admin")) ? "u.is_super_admin" : "false";
    const { rows } = await pool.query(
      `select u.id, u.email, u.name, u.active, u.editor_id, m.role, ${superCol} as "isSuperAdmin",
              -- An open "forgot password" request: asked, and no reset since.
              (select max(a.created_at) from activity a
                where a.org_id = $2 and a.actor_id = u.id and a.verb = 'password_reset_requested'
                  and a.created_at > coalesce((select max(r.created_at) from activity r
                        where r.org_id = $2 and r.entity_id = u.id and r.verb = 'password_reset'), 'epoch'))
                as "resetRequestedAt"
       from membership m
       join app_user u on u.id = m.user_id
       where m.workspace_id = $1
       order by (m.role = 'admin') desc, u.email asc`,
      [req.workspaceId, req.orgId],
    );
    res.json({
      users: rows.map((u) => ({ ...u, isSelf: u.id === req.user.sub })),
    });
  } catch (err) {
    next(err);
  }
});

const CreateSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(["admin", "editor", "viewer"]),
  // A new admin who is also Super Admin (role must be admin).
  superAdmin: z.boolean().optional(),
  // Link straight to a team-member (editor) record at creation — the Teams
  // page's "add person with login" flow does this in one step.
  editorId: z.string().uuid().nullable().optional(),
});

// Add a user to the workspace with a role. Creates the account if the email
// is new (password required); otherwise just grants access to an existing one.
usersRouter.post("/users", requireAdmin, async (req, res, next) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid email, role, and a password (6+ chars) for new users." });
  }
  const { email, name, password, role, editorId } = parsed.data;
  const superAdmin = !!parsed.data.superAdmin && role === "admin";
  const st = await superState(req.workspaceId);
  if (role === "admin" && !(await isSuperUser(req.user.sub, st))) {
    return res.status(403).json({ error: "Only a Super Admin can add an admin." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let { rows } = await client.query(
      "select id, email, name, active from app_user where lower(email) = lower($1)",
      [email],
    );
    let user = rows[0];

    // Someone who already has a login here is changed through Edit, never through
    // this add form: it carries a role (defaulting to editor), so re-adding an
    // existing member — yourself included — would silently overwrite their role.
    if (user) {
      const { rows: member } = await client.query(
        "select 1 from membership where workspace_id = $1 and user_id = $2", [req.workspaceId, user.id],
      );
      if (member.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "That email already has a login on this team. Use Edit on their row instead." });
      }
    }

    if (!user) {
      if (!password) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A password is required for a new user." });
      }
      const hash = await bcrypt.hash(password, 10);
      ({ rows } = await client.query(
        `insert into app_user (email, name, password_hash)
         values ($1, $2, $3) returning id, email, name, active`,
        [email, name ?? null, hash],
      ));
      user = rows[0];
    }

    if (editorId) {
      const { rows: erows } = await client.query(
        "select 1 from editor where id = $1 and org_id = $2", [editorId, req.orgId],
      );
      if (!erows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "That team member wasn't found." });
      }
      const { rows: taken } = await client.query(
        "select 1 from app_user where editor_id = $1 and id != $2", [editorId, user.id],
      );
      if (taken.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "That team member already has a login linked." });
      }
      await client.query("update app_user set editor_id = $1 where id = $2", [editorId, user.id]);
      user.editor_id = editorId;
    }

    await client.query(
      `insert into membership (workspace_id, user_id, role)
       values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set role = excluded.role`,
      [req.workspaceId, user.id, role],
    );
    if (superAdmin && st.on) await client.query("update app_user set is_super_admin = true where id = $1", [user.id]);
    await client.query("COMMIT");
    clearMembershipCache();
    res.status(201).json({ user: { ...user, role, isSuperAdmin: superAdmin && st.on, isSelf: user.id === req.user.sub } });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

const UpdateSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]).optional(),
  // Make (true) or stop being (false) a Super Admin. true also makes them admin.
  superAdmin: z.boolean().optional(),
  active: z.boolean().optional(),
  name: z.string().trim().optional(),
  password: z.string().min(6).optional(),
  // Which team-member (editor) record this login is — powers "My Tasks".
  editorId: z.string().uuid().nullable().optional(),
});

async function adminCount(workspaceId) {
  const { rows } = await pool.query(
    "select count(*)::int c from membership where workspace_id = $1 and role = 'admin'",
    [workspaceId],
  );
  return rows[0].c;
}

const SelfUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  // Data URL (client resizes/encodes before sending, same pattern as an
  // editor's image_url) or null to clear back to an initial-letter avatar.
  imageUrl: z.string().max(500_000).nullable().optional(),
  // A CSS gradient/color value (e.g. "linear-gradient(135deg,#ec4899,#8b5cf6)"),
  // not just a short hex code — needs real room.
  color: z.string().max(120).nullable().optional(),
  // Settings › Notifications: alert key → on/off.
  notifyPrefs: z.record(z.string().max(40), z.boolean()).optional(),
});

// Self-service profile — any authenticated user can update their own display
// name, photo, and accent color. No admin gate: this can only ever touch the
// caller's own row (req.user.sub), never anyone else's. Registered before
// PATCH /users/:id so "me" isn't swallowed as an :id value.
const PasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(200),
});

// Self-service password change — any signed-in user, their own login only. The
// current password is required, so an unattended open session can't be used
// to take the account over. Registered before /users/:id like /users/me.
usersRouter.post("/users/me/password", async (req, res, next) => {
  const parsed = PasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter your current password and a new one of at least 6 characters." });
  }
  const { currentPassword, newPassword } = parsed.data;
  // The bootstrap account's password comes from the server configuration and is
  // re-applied at every start (see ensureBootstrapped), so a change made here
  // would silently revert — refuse it rather than pretend it worked.
  if (req.user.sub === config.ADMIN_USER_ID) {
    return res.status(409).json({ error: "This account's password is set in the server configuration and can't be changed here." });
  }
  try {
    const { rows } = await pool.query("select password_hash from app_user where id = $1", [req.user.sub]);
    if (!rows.length) return res.status(404).json({ error: "Account not found." });
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return res.status(400).json({ error: "Your current password is incorrect." });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "Choose a password different from your current one." });
    }
    await pool.query("update app_user set password_hash = $2 where id = $1", [req.user.sub, await bcrypt.hash(newPassword, 10)]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

usersRouter.patch("/users/me", async (req, res, next) => {
  const parsed = SelfUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid profile update." });
  const d = parsed.data;
  const sets = [];
  const params = [req.user.sub];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (d.name !== undefined) push("name", d.name);
  if (d.imageUrl !== undefined) push("image_url", d.imageUrl);
  if (d.color !== undefined) push("color", d.color);
  if (d.notifyPrefs !== undefined) {
    if (!(await hasColumn("app_user", "notify_prefs"))) {
      return res.status(409).json({ error: "Notification choices need a database update first — ask whoever runs the database to apply 20261023120000_org_settings_notify_prefs." });
    }
    params.push(JSON.stringify(d.notifyPrefs));
    sets.push(`notify_prefs = coalesce(notify_prefs, '{}'::jsonb) || $${params.length}::jsonb`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  try {
    await pool.query(`update app_user set ${sets.join(", ")} where id = $1`, params);
    const { rows } = await pool.query(
      "select id, email, name, image_url, color, editor_id from app_user where id = $1",
      [req.user.sub],
    );
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Update a member: role (in this workspace), account active flag, name, or
// password reset. Protects against locking out the last admin / yourself.
usersRouter.patch("/users/:id", requireAdmin, async (req, res, next) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update." });
  const { active, name, password, editorId, superAdmin } = parsed.data;
  // Super Admin is an admin: making someone one makes them admin too.
  const role = superAdmin === true ? "admin" : parsed.data.role;
  const targetId = req.params.id;
  const isSelf = targetId === req.user.sub;

  try {
    if (editorId) {
      const { rows: erows } = await pool.query(
        "select 1 from editor where id = $1 and org_id = $2",
        [editorId, req.orgId],
      );
      if (!erows.length) return res.status(400).json({ error: "That team member wasn't found." });
      // One login per team member — never take over someone else's record.
      const { rows: taken } = await pool.query("select 1 from app_user where editor_id = $1 and id != $2", [editorId, targetId]);
      if (taken.length) return res.status(409).json({ error: "That team member already has a login linked." });
    }
    const { rows: mrows } = await pool.query(
      "select role from membership where workspace_id = $1 and user_id = $2",
      [req.workspaceId, targetId],
    );
    if (!mrows.length) return res.status(404).json({ error: "User is not a member of this workspace." });
    const currentRole = mrows[0].role;

    // Guard: never leave the workspace without an admin, and don't let an
    // admin lock themselves out.
    if (currentRole === "admin" && (role && role !== "admin")) {
      if (await adminCount(req.workspaceId) <= 1) {
        return res.status(409).json({ error: "This is the last admin — promote someone else first." });
      }
    }
    if (isSelf && active === false) {
      return res.status(409).json({ error: "You can't deactivate your own account." });
    }
    if (isSelf && role && role !== "admin") {
      return res.status(409).json({ error: "You can't remove your own admin role." });
    }

    // Admins are a Super Admin's to manage: making one, or changing another's
    // role, password or sign-in.
    const st = await superState(req.workspaceId);
    const targetSuper = st.on
      ? !!(await pool.query("select is_super_admin from app_user where id = $1", [targetId])).rows[0]?.is_super_admin
      : false;
    const touchesAdmin = (role === "admin" && currentRole !== "admin") || superAdmin === true || (superAdmin === false && targetSuper)
      || (currentRole === "admin" && !isSelf && (role !== undefined || active !== undefined || password !== undefined
        || name !== undefined || editorId !== undefined));
    if (touchesAdmin && !(await isSuperUser(req.user.sub, st))) {
      return res.status(403).json({ error: SUPER_ONLY });
    }
    const losesSuper = targetSuper && (superAdmin === false || (role && role !== "admin"));
    if (losesSuper && st.count <= 1) return res.status(409).json({ error: LAST_SUPER });
    if (st.on && (superAdmin !== undefined || losesSuper)) {
      await pool.query("update app_user set is_super_admin = $2 where id = $1", [targetId, superAdmin === true]);
    }

    if (role) {
      await pool.query(
        "update membership set role = $1 where workspace_id = $2 and user_id = $3",
        [role, req.workspaceId, targetId],
      );
    }
    const sets = [];
    const vals = [];
    if (active !== undefined) { vals.push(active); sets.push(`active = $${vals.length}`); }
    if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
    if (password) { vals.push(await bcrypt.hash(password, 10)); sets.push(`password_hash = $${vals.length}`); }
    if (editorId !== undefined) { vals.push(editorId || null); sets.push(`editor_id = $${vals.length}`); }
    if (sets.length) {
      vals.push(targetId);
      await pool.query(`update app_user set ${sets.join(", ")} where id = $${vals.length}`, vals);
    }
    if (password) {
      const { rows: who } = await pool.query("select coalesce(name, email) as n from app_user where id = $1", [targetId]);
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "password_reset",
        entityType: "user", entityId: targetId,
        summary: `Set a temporary password for ${who[0]?.n ?? "a team member"}`,
      });
    }

    const superCol = st.on ? "u.is_super_admin" : "false";
    const { rows } = await pool.query(
      `select u.id, u.email, u.name, u.active, u.editor_id, m.role, ${superCol} as "isSuperAdmin"
       from app_user u join membership m on m.user_id = u.id and m.workspace_id = $1
       where u.id = $2`,
      [req.workspaceId, targetId],
    );
    clearMembershipCache();
    res.json({ user: { ...rows[0], isSelf } });
  } catch (err) {
    next(err);
  }
});

// Revoke a user's access to this workspace (removes their membership). The
// account itself remains (deactivate it separately to block all login).
usersRouter.delete("/users/:id", requireAdmin, async (req, res, next) => {
  const targetId = req.params.id;
  if (targetId === req.user.sub) {
    return res.status(409).json({ error: "You can't remove your own access." });
  }
  try {
    const { rows } = await pool.query(
      "select role from membership where workspace_id = $1 and user_id = $2",
      [req.workspaceId, targetId],
    );
    if (!rows.length) return res.status(404).json({ error: "User not found in this workspace." });
    if (rows[0].role === "admin" && (await adminCount(req.workspaceId)) <= 1) {
      return res.status(409).json({ error: "This is the last admin — promote someone else first." });
    }
    if (rows[0].role === "admin") {
      const st = await superState(req.workspaceId);
      if (!(await isSuperUser(req.user.sub, st))) return res.status(403).json({ error: SUPER_ONLY });
      const targetSuper = st.on && !!(await pool.query("select is_super_admin from app_user where id = $1", [targetId])).rows[0]?.is_super_admin;
      if (targetSuper && st.count <= 1) return res.status(409).json({ error: LAST_SUPER });
    }
    await pool.query(
      "delete from membership where workspace_id = $1 and user_id = $2",
      [req.workspaceId, targetId],
    );
    clearMembershipCache();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
