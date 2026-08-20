import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { config } from "./config.js";

const DEFAULT_PILLARS = [
  "Diabetes", "Obesity", "Kids", "Nutrition Myths", "Longevity",
];
const DEFAULT_AVATARS = [
  "Diabetes Patient", "Parents", "Working Professional", "Senior Adult",
  "Health Enthusiast", "Weight Loss", "Womens",
];
const DEFAULT_SCORING_WEIGHTS = {
  reel: { views: 0.2, like_rate: 0.15, comment_rate: 0.25, share_rate: 0.25, save_rate: 0.15 },
  carousel: { views: 0.1, like_rate: 0.1, comment_rate: 0.2, share_rate: 0.3, save_rate: 0.3 },
};

// Creates a channel (workspace) owned by `ownerId` (its admin), tags it to the
// org, and seeds scoring + taxonomy. When `sourceWorkspaceId` is given it copies
// that channel's full taxonomy (pillars, avatars, content types, formats) so a
// new channel is immediately usable and consistent with the rest; otherwise it
// seeds the built-in defaults. Runs inside the caller's transaction.
export async function createWorkspace(client, name, ownerId, opts = {}) {
  const { orgId = null, sourceWorkspaceId = null } = opts;
  const { rows } = await client.query(
    "insert into workspace (name, org_id) values ($1, $2) returning id, name, logo_url, brand_colors",
    [name, orgId],
  );
  const workspace = rows[0];

  await client.query(
    `insert into membership (workspace_id, user_id, role)
     values ($1, $2, 'admin')
     on conflict (workspace_id, user_id) do nothing`,
    [workspace.id, ownerId],
  );

  for (const [postType, weights] of Object.entries(DEFAULT_SCORING_WEIGHTS)) {
    await client.query(
      "insert into scoring_config (workspace_id, post_type, weights) values ($1, $2, $3)",
      [workspace.id, postType, weights],
    );
  }

  // Permanent per-scope serials via the DB counter (auto-seeds taxonomy_seq).
  const nextSerial = async (kind, parentId = null) =>
    (await client.query("select public.next_taxonomy_serial($1,$2,$3) as s", [workspace.id, kind, parentId])).rows[0].s;

  if (sourceWorkspaceId) {
    const sp = (await client.query("select id, name from pillar where workspace_id=$1 order by serial", [sourceWorkspaceId])).rows;
    const sa = (await client.query("select name, sort_order from avatar where workspace_id=$1 order by sort_order", [sourceWorkspaceId])).rows;
    const sct = (await client.query("select pillar_id, name from content_type where workspace_id=$1 order by pillar_id, serial", [sourceWorkspaceId])).rows;
    // Format is flat now — copy channel-wide (source is already deduped).
    const sf = (await client.query("select name, post_type from format where workspace_id=$1 order by serial", [sourceWorkspaceId])).rows;
    const pillarName = new Map(sp.map((p) => [p.id, p.name]));
    const newPillar = new Map();
    for (const p of sp) {
      const serial = await nextSerial("pillar");
      const r = await client.query("insert into pillar (workspace_id, name, sort_order, serial) values ($1,$2,$3,$3) returning id", [workspace.id, p.name, serial]);
      newPillar.set(p.name, r.rows[0].id);
    }
    for (const a of sa) await client.query("insert into avatar (workspace_id, name, sort_order) values ($1,$2,$3)", [workspace.id, a.name, a.sort_order]);
    for (const ct of sct) {
      const pid = newPillar.get(pillarName.get(ct.pillar_id));
      if (pid) await client.query("insert into content_type (workspace_id, pillar_id, name, serial) values ($1,$2,$3,$4)", [workspace.id, pid, ct.name, await nextSerial("type", pid)]);
    }
    for (const f of sf) await client.query("insert into format (workspace_id, name, post_type, serial) values ($1,$2,$3,$4)", [workspace.id, f.name, f.post_type, await nextSerial("format")]);
  } else {
    for (const pName of DEFAULT_PILLARS) await client.query("insert into pillar (workspace_id, name, sort_order, serial) values ($1, $2, $3, $3)", [workspace.id, pName, await nextSerial("pillar")]);
    for (const [i, aName] of DEFAULT_AVATARS.entries()) await client.query("insert into avatar (workspace_id, name, sort_order) values ($1, $2, $3)", [workspace.id, aName, i + 1]);
  }

  return workspace;
}

// Idempotent startup guard:
//  - upsert the env-configured admin into app_user (env stays authoritative
//    for this bootstrap account's password),
//  - ensure at least one workspace exists with that admin as a member.
export async function ensureBootstrapped() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const hash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
    await client.query(
      `insert into app_user (id, email, name, password_hash, active)
       values ($1, $2, 'Admin', $3, true)
       on conflict (id) do update
         set email = excluded.email,
             password_hash = excluded.password_hash,
             active = true`,
      [config.ADMIN_USER_ID, config.ADMIN_EMAIL, hash],
    );

    const { rows } = await client.query(
      "select id from workspace order by created_at asc limit 1",
    );
    let workspaceId = rows[0]?.id;

    if (!workspaceId) {
      const ws = await createWorkspace(client, "DF Foods", config.ADMIN_USER_ID);
      workspaceId = ws.id;
      console.log(`Bootstrapped default workspace ${workspaceId}`);
    } else {
      // The env-configured admin is always an admin of their home workspace —
      // this guarantees they can never be locked out of management.
      await client.query(
        `insert into membership (workspace_id, user_id, role)
         values ($1, $2, 'admin')
         on conflict (workspace_id, user_id) do update set role = 'admin'`,
        [workspaceId, config.ADMIN_USER_ID],
      );
    }

    await client.query("COMMIT");
    return workspaceId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
