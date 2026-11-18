import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { hasColumn } from "../schema-flags.js";
import { createWorkspace } from "../bootstrap.js";
import { logActivity } from "../activity.js";
import { requirePermission } from "../permissions.js";
import { resolveWorkspace } from "../resolve-workspace.js";

export const workspacesRouter = Router();

// A brand's short name (DF, MHS: 20261106120000_brand_short_name.sql), once
// that change is in the database; before it, none, and the app makes one up.
const shortReady = () => hasColumn("workspace", "short_name");
const shortCol = async (alias = "w") => ((await shortReady()) ? `${alias}.short_name` : "null::text as short_name");

// Channels visible in the switcher. An org-wide admin (admin of any channel in
// an org) sees EVERY channel in that org — including ones they aren't a member
// of, shown as 'admin'. Everyone else sees only channels they're a member of.
workspacesRouter.get("/workspaces", async (req, res, next) => {
  try {
    const uid = req.user.sub;
    // Orgs where the user is an admin of at least one channel => full org access.
    const adminOrgs = (await pool.query(
      `select distinct w.org_id from workspace w
         join membership m on m.workspace_id = w.id
        where m.user_id = $1 and m.role = 'admin' and w.org_id is not null`,
      [uid],
    )).rows.map((r) => r.org_id);

    const { rows } = await pool.query(
      `select w.id, w.name, w.logo_url, ${await shortCol()},
              case when w.org_id = any($2::uuid[]) then 'admin'::membership_role else m.role end as role,
              coalesce((
                select array_agg(g.permission_key)
                from user_permission_grant g
                where g.org_id = w.org_id and g.user_id = $1 and g.revoked_at is null
              ), '{}') as permissions
       from workspace w
       left join membership m on m.workspace_id = w.id and m.user_id = $1
       where m.user_id = $1 or w.org_id = any($2::uuid[])
       order by w.created_at asc`,
      [uid, adminOrgs],
    );
    res.json({ workspaces: rows });
  } catch (err) {
    next(err);
  }
});

// Every brand of the organisation, for picking a task's brand: any of them can
// be one, whichever you're on (the switcher above shows only yours). Names only.
workspacesRouter.get("/brands", resolveWorkspace, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select w.id, w.name, w.logo_url, ${await shortCol()} from workspace w where w.org_id = $1 order by w.created_at asc`,
      [req.orgId],
    );
    res.json({ brands: rows });
  } catch (err) {
    next(err);
  }
});

const NameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Create a new workspace — the creator becomes its admin.
workspacesRouter.post("/workspaces", resolveWorkspace, requirePermission("channels"), async (req, res, next) => {
  const parsed = NameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Workspace name is required." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The new channel goes in the org this request is for (where the Channels
    // permission was checked), copying the taxonomy of one of its channels.
    const orgId = req.orgId ?? (await client.query("select id from org order by created_at limit 1")).rows[0]?.id ?? null;
    const ctx = await client.query(
      "select id from workspace where org_id = $1 order by created_at asc limit 1",
      [orgId],
    );
    const sourceWorkspaceId = ctx.rows[0]?.id ?? null;
    // An admin makes it as its admin; someone with only the Channels grant joins
    // it as an editor (admin of any channel would make them admin of the org).
    const ownerRole = req.role === "admin" ? "admin" : "editor";

    const workspace = await createWorkspace(client, parsed.data.name, req.user.sub, { orgId, sourceWorkspaceId, ownerRole });

    // Enable Instagram by default so the new channel is immediately usable.
    if (orgId) {
      const ig = await client.query("select id from platform where key = 'instagram'");
      if (ig.rows[0]) {
        await client.query(
          `insert into account (org_id, workspace_id, platform_id, handle)
           values ($1,$2,$3,$4) on conflict (workspace_id, platform_id) do nothing`,
          [orgId, workspace.id, ig.rows[0].id, "@" + parsed.data.name],
        );
      }
    }
    await client.query("COMMIT");
    if (orgId) {
      await logActivity({
        orgId, actorId: req.user.sub, verb: "channel_added",
        entityType: "channel", entityId: workspace.id, channelId: workspace.id,
        summary: `Added channel “${workspace.name}”`,
      });
    }
    res.status(201).json({ workspace });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Rename a workspace the user is an admin of, or set its short name (empty:
// back to the initials the app makes).
const BrandEditSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required.").max(80).optional(),
  shortName: z.string().trim().max(8, "Keep the short name to 8 characters.").regex(/^[\p{L}\p{N}&+.\- ]*$/u, "Letters and numbers only.").nullable().optional(),
}).refine((d) => d.name !== undefined || d.shortName !== undefined, "Workspace name is required.");
workspacesRouter.patch("/workspaces/:id", resolveWorkspace, requirePermission("channels"), async (req, res, next) => {
  const parsed = BrandEditSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Workspace name is required." });
  }
  try {
    const d = parsed.data;
    const short = await shortReady();
    if (d.shortName !== undefined && !short) {
      return res.status(409).json({ error: "Short names need a database change first: 20261106120000_brand_short_name.sql." });
    }
    const sets = ["updated_at = now()"], params = [req.params.id, req.orgId];
    if (d.name !== undefined) { params.push(d.name); sets.push(`name = $${params.length}`); }
    if (d.shortName !== undefined) { params.push(d.shortName || null); sets.push(`short_name = $${params.length}`); }
    // Org-admins (enforced by requirePermission) can rename any channel in their
    // org, so gate on the org rather than a personal membership row.
    const { rows } = await pool.query(
      `update workspace set ${sets.join(", ")}
       where id = $1 and org_id = $2
       returning id, name, logo_url${short ? ", short_name" : ""}`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: "Workspace not found" });
    res.json({ workspace: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Delete a channel the user is an admin of. Cascades its posts, platform
// accounts, taxonomy, memberships & Instagram connections; keeps the shared
// team (editors are reassigned to another channel) and keeps tasks (their
// channel link is just cleared). Refuses to delete the org's only channel.
// What deleting a channel would do, said before it's done: who'd lose Echo —
// people (switched on) for whom it's the only channel they belong to — and how
// many tasks lose their brand (they stay, un-linked) and posts go with it.
async function deleteCheck(db, wsId, orgId) {
  const [{ rows: lockedOut }, { rows: [n] }] = await Promise.all([
    db.query(
      `select u.id, coalesce(e.name, u.name, u.email) as name
         from app_user u join membership m on m.user_id = u.id and m.workspace_id = $1
         left join editor e on e.id = u.editor_id
        where u.active
          and not exists (select 1 from membership m2 join workspace w2 on w2.id = m2.workspace_id
                           where m2.user_id = u.id and w2.org_id = $2 and m2.workspace_id <> $1)
        order by 2`,
      [wsId, orgId],
    ),
    db.query(
      `select (select count(*)::int from task where channel_id = $1) as tasks,
              (select count(*)::int from post where workspace_id = $1) as posts`,
      [wsId],
    ),
  ]);
  return { lockedOut, tasks: n.tasks, posts: n.posts };
}
const namesOf = (people) => {
  const n = people.map((p) => p.name);
  return n.length <= 2 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};
export const lockOutWords = (people) =>
  `${namesOf(people)} would lose Echo: this is the only channel ${people.length === 1 ? "they belong" : "they all belong"} to. `
  + "Give them another channel first (switch to it, then add their login on Team › Roster), or delete a different one.";

workspacesRouter.get("/workspaces/:id/delete-check", resolveWorkspace, requirePermission("channels"), async (req, res, next) => {
  try {
    const { rows: [ws] } = await pool.query("select id, org_id from workspace where id = $1 and org_id = $2", [req.params.id, req.orgId]);
    if (!ws) return res.status(404).json({ error: "Channel not found" });
    res.json(await deleteCheck(pool, ws.id, ws.org_id));
  } catch (err) { next(err); }
});

workspacesRouter.delete("/workspaces/:id", resolveWorkspace, requirePermission("channels"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // requirePermission("channels") already confirmed the caller is an admin of
    // this org, so gate on the channel being in their org rather than on a
    // personal membership row (org-admins can delete channels they never joined).
    const ws = (await client.query(
      `select w.id, w.org_id from workspace w where w.id = $1 and w.org_id = $2`,
      [req.params.id, req.orgId],
    )).rows[0];
    if (!ws) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Channel not found" });
    }
    // A landing spot for the shared team + a guard against deleting the last one.
    const other = (await client.query(
      "select id from workspace where org_id = $1 and id <> $2 order by created_at asc limit 1",
      [ws.org_id, ws.id],
    )).rows[0];
    if (!other) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This is your only channel — you can't delete it." });
    }
    // The Super Admin's only admin role must not go with it (they'd lose the
    // Super Admin settings).
    if (await hasColumn("app_user", "is_super_admin")) {
      const { rows: only } = await client.query(
        `select 1 from app_user u
          where u.is_super_admin
            and exists (select 1 from membership m where m.user_id = u.id and m.workspace_id = $1 and m.role = 'admin')
            and not exists (select 1 from membership m join workspace w on w.id = m.workspace_id
                             where m.user_id = u.id and m.role = 'admin' and w.org_id = $2 and m.workspace_id <> $1)
          limit 1`,
        [ws.id, ws.org_id],
      );
      if (only.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This channel holds the Super Admin's admin role. Make them an admin of another channel first." });
      }
    }
    // Nobody is locked out of Echo by it: for anyone switched on, it mustn't be their only channel.
    const check = await deleteCheck(client, ws.id, ws.org_id);
    if (check.lockedOut.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: lockOutWords(check.lockedOut), lockedOut: check.lockedOut });
    }
    // Editors are the org's shared team (NOT NULL workspace_id cascades) — move
    // them to another channel so they survive.
    await client.query("update editor set workspace_id = $1 where workspace_id = $2", [other.id, ws.id]);
    // Delete posts explicitly FIRST, while the workspace still exists: the
    // post_audit_log trigger writes an audit_log row (referencing this
    // workspace) on every post delete. If posts were left to cascade with the
    // workspace, that trigger would fire after the workspace row is gone and the
    // audit_log FK would fail — so a channel with any posts could never be
    // deleted. Deleting posts now keeps those audit rows valid; the workspace
    // delete then cascades them away.
    await client.query("delete from post where workspace_id = $1", [ws.id]);
    // Recorded ad numbers and their results belong to the task, not the brand:
    // they let go of it rather than go with it (task_ad's brand link cascades).
    if (await hasColumn("task_ad", "workspace_id")) {
      await client.query("update task_ad set workspace_id = null where workspace_id = $1", [ws.id]);
    }
    await client.query("delete from workspace where id = $1", [ws.id]);
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});
