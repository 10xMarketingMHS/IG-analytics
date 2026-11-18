import { pool } from "./db.js";

// Database changes reach Supabase by hand (server/scripts/apply-migration.js),
// so a newer server can run for a while against a database that hasn't had
// the change yet. Code that reads a newly added column asks here first and
// does without it until the change is applied. A column once found is
// remembered; a missing one is looked up again after a minute, so applying the
// change needs no restart.
const found = new Set();
const missingUntil = new Map();

export async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (found.has(key)) return true;
  if ((missingUntil.get(key) ?? 0) > Date.now()) return false;
  const { rows } = await pool.query(
    "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
    [table, column],
  );
  if (rows.length) { found.add(key); return true; }
  missingUntil.set(key, Date.now() + 60_000);
  return false;
}
