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

// Creates a workspace owned by `ownerId` (who becomes its admin) and seeds
// default scoring weights + starter pillars & avatars. Runs in a transaction.
export async function createWorkspace(client, name, ownerId) {
  const { rows } = await client.query(
    "insert into workspace (name) values ($1) returning id, name, logo_url, brand_colors",
    [name],
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
  for (const [i, pName] of DEFAULT_PILLARS.entries()) {
    await client.query(
      "insert into pillar (workspace_id, name, sort_order) values ($1, $2, $3)",
      [workspace.id, pName, i + 1],
    );
  }
  for (const [i, aName] of DEFAULT_AVATARS.entries()) {
    await client.query(
      "insert into avatar (workspace_id, name, sort_order) values ($1, $2, $3)",
      [workspace.id, aName, i + 1],
    );
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
