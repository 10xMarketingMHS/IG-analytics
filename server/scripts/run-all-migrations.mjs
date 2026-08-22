// One-off runner: applies every .sql file in pulse-app/supabase/migrations,
// in filename (chronological) order, against DATABASE_URL. Each file runs in
// its own transaction; stops on first failure.
// NOT part of the app — used to bootstrap a fresh (e.g. staging) database.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node run-all-migrations.mjs <migrations-dir>");
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

for (const file of files) {
  const sql = fs.readFileSync(path.join(dir, file), "utf8");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    console.log(`✅ ${file}`);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error(`❌ ${file}: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\nAll ${files.length} migrations applied.`);
await client.end();
