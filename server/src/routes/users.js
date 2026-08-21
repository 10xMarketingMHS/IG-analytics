import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin, clearMembershipCache } from "../resolve-workspace.js";

export const usersRouter = Router();

const ROLES = ["admin", "editor", "viewer"];

// Everything here is admin-only.
usersRouter.use(requireAdmin);

// List the members of the active workspace with their role.
usersRouter.get("/users", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select u.id, u.email, u.name, u.active, u.editor_id, m.role
       from membership m
       join app_user u on u.id = m.user_id
       where m.workspace_id = $1
       order by (m.role = 'admin') desc, u.email asc`,
      [req.workspaceId],
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
});

// Add a user to the workspace with a role. Creates the account if the email
// is new (password required); otherwise just grants access to an existing one.
usersRouter.post("/users", async (req, res, next) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid email, role, and a password (6+ chars) for new users." });
  }
  const { email, name, password, role } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let { rows } = await client.query(
      "select id, email, name, active from app_user where lower(email) = lower($1)",
      [email],
    );
    let user = rows[0];

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

    await client.query(
      `insert into membership (workspace_id, user_id, role)
       values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set role = excluded.role`,
      [req.workspaceId, user.id, role],
    );
    await client.query("COMMIT");
    clearMembershipCache();
    res.status(201).json({ user: { ...user, role, isSelf: user.id === req.user.sub } });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

const UpdateSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]).optional(),
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

// Update a member: role (in this workspace), account active flag, name, or
// password reset. Protects against locking out the last admin / yourself.
usersRouter.patch("/users/:id", async (req, res, next) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update." });
  const { role, active, name, password, editorId } = parsed.data;
  const targetId = req.params.id;
  const isSelf = targetId === req.user.sub;

  try {
    if (editorId) {
      const { rows: erows } = await pool.query(
        "select 1 from editor where id = $1 and org_id = $2",
        [editorId, req.orgId],
      );
      if (!erows.length) return res.status(400).json({ error: "That team member wasn't found." });
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

    const { rows } = await pool.query(
      `select u.id, u.email, u.name, u.active, u.editor_id, m.role
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
usersRouter.delete("/users/:id", async (req, res, next) => {
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
