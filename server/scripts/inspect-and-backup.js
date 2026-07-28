// One-off: inspect the live schema/data and dump affected tables to JSON so we
// have an instant rollback point before the Media House migration.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// A single dedicated client (not the app pool) so we don't warm connections or
// exhaust the Supabase session pooler while the migration runs.
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../backups");
fs.mkdirSync(outDir, { recursive: true });

async function q(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}

async function tableExists(name) {
  const r = await q(
    "select to_regclass($1) as reg",
    [`public.${name}`],
  );
  return r[0].reg !== null;
}

const CANDIDATE_TABLES = [
  "app_user",
  "workspace",
  "membership",
  "editor",
  "post",
  "pillar",
  "avatar",
  "content_type",
  "format",
  "task",
  "org",
];

async function main() {
  const present = [];
  for (const t of CANDIDATE_TABLES) {
    if (await tableExists(t)) present.push(t);
  }
  console.log("TABLES PRESENT:", present.join(", "));

  // High-level shape
  const workspaces = await q("select id, name from workspace order by name");
  console.log(`\nWORKSPACES (${workspaces.length}):`);
  for (const w of workspaces) {
    const [{ count: postCount }] = await q(
      "select count(*)::int as count from post where workspace_id=$1",
      [w.id],
    );
    const eds = await q(
      "select name, designation from editor where workspace_id=$1 order by name",
      [w.id],
    );
    console.log(
      `  • ${w.name} (${w.id})  posts=${postCount}  editors=[${eds
        .map((e) => e.name)
        .join(", ")}]`,
    );
  }

  const [{ count: editorTotal }] = await q("select count(*)::int as count from editor");
  const [{ count: postTotal }] = await q("select count(*)::int as count from post");
  const [{ count: memberTotal }] = await q("select count(*)::int as count from membership");
  console.log(
    `\nTOTALS: editors=${editorTotal} posts=${postTotal} memberships=${memberTotal}`,
  );

  // Unique editor names across all workspaces (preview of the consolidated team)
  const uniqueNames = await q(
    "select distinct lower(trim(name)) as key, min(name) as sample from editor group by lower(trim(name)) order by 1",
  );
  console.log(
    `\nUNIQUE EDITOR NAMES (${uniqueNames.length}) → future Media House team:`,
    uniqueNames.map((u) => u.sample).join(", "),
  );

  // Dump each present table to JSON
  const stamp = process.argv[2] || "backup";
  const dump = {};
  for (const t of present) {
    dump[t] = await q(`select * from ${t}`);
  }
  const file = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(
    `\nBACKUP written: ${file}  (` +
      present.map((t) => `${t}:${dump[t].length}`).join(" ") +
      ")",
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
