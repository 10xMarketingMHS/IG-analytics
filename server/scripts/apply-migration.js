// Apply a single .sql migration file (path via argv[2]) inside a transaction,
// using one dedicated client. Rolls back automatically on any error.
import "dotenv/config";
import fs from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-migration.js <path-to.sql>");
  process.exit(1);
}
const sql = fs.readFileSync(file, "utf8");

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log("✅ migration applied:", file);

  // Verify
  const orgs = (await client.query("select id, name from public.org")).rows;
  const [{ count: chWithOrg }] = (
    await client.query("select count(*)::int as count from public.workspace where org_id is not null")
  ).rows;
  const [{ count: edWithOrg }] = (
    await client.query("select count(*)::int as count from public.editor where org_id is not null")
  ).rows;
  const taskReg = (await client.query("select to_regclass('public.task') as reg")).rows[0].reg;
  console.log(
    `orgs=${orgs.map((o) => o.name).join(",")}  channels_with_org=${chWithOrg}  editors_with_org=${edWithOrg}  task_table=${taskReg}`,
  );
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("❌ migration failed — rolled back:\n", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
