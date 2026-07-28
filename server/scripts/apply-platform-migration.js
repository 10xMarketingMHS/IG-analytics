// One-off Phase 1 migration: platforms, accounts, post.platform_id, channel
// rename, new channels, and the account grid. All in one transaction.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(
  path.resolve(here, "../../pulse-app/supabase/migrations/20260714140000_platforms_and_accounts.sql"),
  "utf8",
);

const PLATFORMS = [
  { key: "instagram", name: "Instagram", sort_order: 1 },
  { key: "facebook", name: "Facebook", sort_order: 2 },
  { key: "youtube", name: "YouTube", sort_order: 3 },
];

// Channel → platforms it's active on (the ✓ grid).
const GRID = {
  doctorfarmer: ["instagram", "facebook", "youtube"],
  myhealthschool: ["instagram", "facebook", "youtube"],
  myhealthsummit: ["instagram", "facebook"],
  fofitos: ["instagram", "facebook"],
};

const DEFAULT_PILLARS = ["Diabetes", "Obesity", "Kids", "Nutrition Myths", "Longevity"];
const DEFAULT_AVATARS = [
  "Diabetes Patient", "Parents", "Working Professional", "Senior Adult",
  "Health Enthusiast", "Weight Loss", "Womens",
];
const DEFAULT_SCORING_WEIGHTS = {
  reel: { views: 0.2, like_rate: 0.15, comment_rate: 0.25, share_rate: 0.25, save_rate: 0.15 },
  carousel: { views: 0.1, like_rate: 0.1, comment_rate: 0.2, share_rate: 0.3, save_rate: 0.3 },
};

const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const q = (sql, params = []) => client.query(sql, params);

async function ensureChannel(name, orgId) {
  const existing = await q("select id from workspace where name = $1", [name]);
  if (existing.rows.length) return existing.rows[0].id;

  const { rows } = await q(
    "insert into workspace (name, org_id) values ($1, $2) returning id",
    [name, orgId],
  );
  const wsId = rows[0].id;
  await q(
    `insert into membership (workspace_id, user_id, role) values ($1, $2, 'admin')
     on conflict (workspace_id, user_id) do nothing`,
    [wsId, ADMIN_USER_ID],
  );
  for (const [pt, w] of Object.entries(DEFAULT_SCORING_WEIGHTS)) {
    await q("insert into scoring_config (workspace_id, post_type, weights) values ($1,$2,$3)", [wsId, pt, w]);
  }
  for (const [i, p] of DEFAULT_PILLARS.entries()) {
    await q("insert into pillar (workspace_id, name, sort_order) values ($1,$2,$3)", [wsId, p, i + 1]);
  }
  for (const [i, a] of DEFAULT_AVATARS.entries()) {
    await q("insert into avatar (workspace_id, name, sort_order) values ($1,$2,$3)", [wsId, a, i + 1]);
  }
  console.log(`  created channel: ${name}`);
  return wsId;
}

try {
  await q("begin");

  // 1. Schema
  await q(DDL);

  // 2. Seed platforms → key→id map
  const pid = {};
  for (const p of PLATFORMS) {
    await q(
      `insert into platform (key, name, sort_order) values ($1,$2,$3)
       on conflict (key) do update set name = excluded.name, sort_order = excluded.sort_order`,
      [p.key, p.name, p.sort_order],
    );
  }
  for (const r of (await q("select id, key from platform")).rows) pid[r.key] = r.id;

  // 3. Backfill existing posts → Instagram
  const bf = await q("update post set platform_id = $1 where platform_id is null", [pid.instagram]);
  console.log(`backfilled ${bf.rowCount} posts → Instagram`);

  // 4. Rename the legacy channel
  const rn = await q("update workspace set name = 'doctorfarmer' where name = 'iamdoctorfarmer'");
  console.log(`renamed iamdoctorfarmer → doctorfarmer (${rn.rowCount})`);

  // 5. Org
  const orgId = (await q("select id from org order by created_at limit 1")).rows[0].id;

  // 6. Ensure all channels + 7. build the account grid
  for (const [channel, platforms] of Object.entries(GRID)) {
    const wsId = await ensureChannel(channel, orgId);
    for (const pkey of platforms) {
      await q(
        `insert into account (org_id, workspace_id, platform_id, handle)
         values ($1,$2,$3,$4)
         on conflict (workspace_id, platform_id) do nothing`,
        [orgId, wsId, pid[pkey], "@" + channel],
      );
    }
  }

  await q("commit");
  console.log("✅ committed");

  // Verify
  const channels = (await q("select name from workspace order by name")).rows.map((r) => r.name);
  const [{ count: accts }] = (await q("select count(*)::int as count from account")).rows;
  const [{ count: pf }] = (await q("select count(*)::int as count from platform")).rows;
  const [{ count: taggedPosts }] = (
    await q("select count(*)::int as count from post where platform_id is not null")
  ).rows;
  console.log(`platforms=${pf}  channels=[${channels.join(", ")}]  accounts=${accts}  posts_tagged=${taggedPosts}`);
} catch (e) {
  await q("rollback").catch(() => {});
  console.error("❌ failed — rolled back:\n", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
