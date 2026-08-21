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
    // Set-based copy: a handful of INSERT…SELECT statements instead of ~2 DB
    // round-trips per taxonomy item (which made channel creation take ~24s).
    // The channel is brand new, so serials restart at 1 in each scope, assigned
    // by row_number() over the SOURCE serial order so P1/T1/F1 correspond to the
    // source's. Pillars & formats are channel-wide (unpartitioned); content-types
    // restart per NEW pillar; avatars carry no serial. Counters are then seeded to
    // max+1 per scope so later manual adds keep counting from the right place.
    const ws = workspace.id;

    // Pillars — channel-wide. sort_order tracks serial, as before.
    await client.query(
      `insert into pillar (workspace_id, name, sort_order, serial)
       select $1, sp.name,
              row_number() over (order by sp.serial),
              row_number() over (order by sp.serial)
         from pillar sp where sp.workspace_id = $2`,
      [ws, sourceWorkspaceId],
    );
    // Avatars — plain bulk copy, no serial logic.
    await client.query(
      `insert into avatar (workspace_id, name, sort_order)
       select $1, name, sort_order from avatar where workspace_id = $2`,
      [ws, sourceWorkspaceId],
    );
    // Formats — channel-wide, decoupled from pillars.
    await client.query(
      `insert into format (workspace_id, name, post_type, serial)
       select $1, sf.name, sf.post_type, row_number() over (order by sf.serial)
         from format sf where sf.workspace_id = $2`,
      [ws, sourceWorkspaceId],
    );
    // Content types — nest under the NEW pillar (matched to source by name);
    // serial restarts per new pillar, ordered by the source type's serial.
    await client.query(
      `insert into content_type (workspace_id, pillar_id, name, serial)
       select $1, np.id, sct.name,
              row_number() over (partition by np.id order by sct.serial)
         from content_type sct
         join pillar sp on sp.id = sct.pillar_id
         join pillar np on np.workspace_id = $1 and np.name = sp.name
        where sct.workspace_id = $2`,
      [ws, sourceWorkspaceId],
    );
    // Seed permanent counters to max+1 per scope (serials are contiguous 1..N).
    await client.query(
      `insert into taxonomy_seq (workspace_id, kind, parent_id, next_val)
       select $1, 'pillar', null, count(*) + 1 from pillar where workspace_id = $1 having count(*) > 0`,
      [ws],
    );
    await client.query(
      `insert into taxonomy_seq (workspace_id, kind, parent_id, next_val)
       select $1, 'format', null, count(*) + 1 from format where workspace_id = $1 having count(*) > 0`,
      [ws],
    );
    await client.query(
      `insert into taxonomy_seq (workspace_id, kind, parent_id, next_val)
       select workspace_id, 'type', pillar_id, count(*) + 1
         from content_type where workspace_id = $1
        group by workspace_id, pillar_id`,
      [ws],
    );
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
      // On a truly fresh database (no workspace yet) the single Media House
      // org row already exists (seeded by its own migration) — link the
      // bootstrap workspace to it, or every org-scoped query (editors,
      // tasks, time rules...) silently returns nothing for it.
      const { rows: orgRows } = await client.query(
        "select id from org order by created_at asc limit 1",
      );
      const ws = await createWorkspace(client, "DF Foods", config.ADMIN_USER_ID, { orgId: orgRows[0]?.id ?? null });
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
