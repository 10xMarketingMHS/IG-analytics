// Run one SQL file (a migration, say) on a database, as one piece. Web SQL
// editors (Aiven's, for one) split what you paste at every ";" and so break a
// function's body; this sends the whole file at once, in one transaction —
// it all applies, or none of it does.
//
// Run it yourself, with the address set in your own terminal (never written to
// a file or printed):
//   PowerShell:  $env:TARGET_DATABASE_URL = "postgres://…"
//                node scripts/run-sql.mjs ../pulse-app/supabase/migrations/<file>.sql
import fs from "node:fs";
import pg from "pg";

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
const file = process.argv[2];
if (!file || !fs.existsSync(file)) fail("Give the SQL file to run, for example ../pulse-app/supabase/migrations/<file>.sql");
const url = process.env.TARGET_DATABASE_URL;
if (!url) fail("Set TARGET_DATABASE_URL (the database to run it on) in this terminal first.");
let u;
try { u = new URL(url); } catch { fail("TARGET_DATABASE_URL isn't a database address (postgres://…)."); }
// on this machine: no SSL; elsewhere encrypted, as the Echo server connects
const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
u.searchParams.delete("sslmode");
const db = new pg.Client({ connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: false }, application_name: "pulse-run-sql" });
try {
  await db.connect();
} catch (e) {
  fail(`Couldn't reach ${u.hostname}: ${e.message}`);
}
try {
  await db.query("begin");
  await db.query(fs.readFileSync(file, "utf8"));
  await db.query("commit");
  console.log(`✓ Done: ${file.split(/[\\/]/).pop()} ran on ${u.hostname}${u.pathname}.`);
} catch (e) {
  await db.query("rollback").catch(() => {});
  fail(`It didn't run, so nothing changed: ${e.message}`);
} finally {
  await db.end().catch(() => {});
}
