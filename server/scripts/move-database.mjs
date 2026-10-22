// Move Pulse's database to another Postgres (Supabase → Aiven, say): build
// Pulse's tables on the new one, copy every row across, and check the counts.
//
// Run it yourself, with the two addresses set in your own terminal (they are
// never written to a file or printed):
//   PowerShell:  $env:SOURCE_DATABASE_URL = "postgres://…"   (where Pulse is now)
//                $env:TARGET_DATABASE_URL = "postgres://…"   (the new, empty one)
//                node scripts/move-database.mjs
//
// The source is only ever read (its session is read-only). On the target:
//   1. Pulse's tables are made from every file in pulse-app/supabase/migrations,
//      in order (a re-run skips the ones already applied);
//   2. all of its rows are replaced with the source's, in one transaction —
//      anything fails, and the target is left as it was before this step;
//   3. row counts are compared, table by table.
// A target that already holds Pulse data (logins) is refused unless you add
// --replace. Point Render's DATABASE_URL at the target only after this is done.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../pulse-app/supabase/migrations");
const REPLACE = process.argv.includes("--replace");
// every value as Postgres sends it (text), so nothing is reshaped on the way:
// dates stay dates, numbers keep their digits, JSON stays as written
const RAW = { getTypeParser: () => (v) => v };

// What the migrations expect from Supabase (as in .local-db/db.mjs): the auth
// schema, auth.uid() and its three roles — inert here, the server signs people
// in itself.
const SUPABASE_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (
    id                 uuid primary key default gen_random_uuid(),
    email              text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at         timestamptz not null default now()
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  do $$
  declare r text;
  begin
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin', r);
      end if;
    end loop;
  end $$;
  create table if not exists public.local_migration_log (
    version    text primary key,
    applied_at timestamptz not null default now()
  );
`;

function fail(msg) {
  console.error(`\n✗ ${msg}\nNothing more was done.`);
  process.exit(1);
}
// A client for one address. On this machine: no SSL. Elsewhere: encrypted,
// without checking the certificate — as the Pulse server connects today.
function client(url, label) {
  let u;
  try { u = new URL(url); } catch { fail(`${label} isn't a database address (postgres://…).`); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  u.searchParams.delete("sslmode");
  return {
    where: `${u.hostname}:${u.port || 5432}${u.pathname}`,
    db: new pg.Client({ connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: false }, types: RAW, application_name: "pulse-move" }),
  };
}
const q = async (c, sql, params) => (await c.query(sql, params)).rows;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

const SRC = process.env.SOURCE_DATABASE_URL, DST = process.env.TARGET_DATABASE_URL;
if (!SRC || !DST) fail("Set SOURCE_DATABASE_URL (where Pulse is now) and TARGET_DATABASE_URL (the new database) in this terminal first.");
const src = client(SRC, "SOURCE_DATABASE_URL"), dst = client(DST, "TARGET_DATABASE_URL");
if (src.where === dst.where) fail("The source and the target are the same database.");

console.log("1 · Connecting");
try { await src.db.connect(); } catch (e) { fail(`Couldn't reach the source (${src.where}): ${e.message}`); }
await src.db.query("set default_transaction_read_only = on"); // never writes there
console.log(`  source ${src.where} · ok (read only)`);
try { await dst.db.connect(); } catch (e) { fail(`Couldn't reach the target (${dst.where}): ${e.message}`); }
console.log(`  target ${dst.where} · ok`);

try {
  const has = await q(dst.db, "select to_regclass('public.app_user') is not null as yes");
  if (has[0].yes === "t" && !REPLACE) {
    const [{ n }] = await q(dst.db, "select count(*) as n from public.app_user");
    if (Number(n) > 0) fail(`The target already has Pulse data (${n} logins). Run with --replace to overwrite it.`);
  }

  console.log("2 · Building Pulse's tables on the target");
  await dst.db.query(SUPABASE_SHIM);
  const done = new Set((await q(dst.db, "select version from public.local_migration_log")).map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (done.has(version)) continue;
    try {
      await dst.db.query("begin");
      await dst.db.query(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
      await dst.db.query("insert into public.local_migration_log (version) values ($1)", [version]);
      await dst.db.query("commit");
      applied++;
    } catch (e) {
      await dst.db.query("rollback").catch(() => {});
      fail(`${f} didn't apply on the target: ${e.message}`);
    }
  }
  console.log(`  ${applied} change(s) applied, ${files.length} in all`);

  console.log("3 · Copying the rows");
  const tablesOf = async (c) => (await q(c, "select tablename from pg_tables where schemaname = 'public' and tablename <> 'local_migration_log' order by 1")).map((r) => r.tablename);
  const srcTables = new Set(await tablesOf(src.db));
  const tables = (await tablesOf(dst.db)).filter((t) => srcTables.has(t));
  const onlySrc = [...srcTables].filter((t) => !tables.includes(t));
  const colsOf = async (c, t, writable) => q(c,
    `select a.attname as name, a.attidentity as identity from pg_attribute a
      where a.attrelid = ('public.' || quote_ident($1))::regclass and a.attnum > 0 and not a.attisdropped
        ${writable ? "and a.attgenerated = ''" : ""} order by a.attnum`, [t]);

  const report = [];
  let fks = [];
  try {
  await dst.db.query("begin");
  // foreign keys off while rows go in (re-added, and so re-checked, after);
  // Pulse's own triggers (audit rows, say) off too: the rows arrive as they were
  fks = await q(dst.db,
    `select c.conrelid::regclass::text as tbl, c.conname as name, pg_get_constraintdef(c.oid) as def
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`);
  for (const k of fks) await dst.db.query(`alter table ${k.tbl} drop constraint ${ident(k.name)}`);
  for (const t of tables) await dst.db.query(`alter table public.${ident(t)} disable trigger user`);
  if (tables.length) await dst.db.query(`truncate ${tables.map((t) => `public.${ident(t)}`).join(", ")} restart identity`);

  for (const t of tables) {
    const want = await colsOf(dst.db, t, true);
    const there = new Set((await colsOf(src.db, t, false)).map((c) => c.name));
    const cols = want.filter((c) => there.has(c.name));
    const missing = want.filter((c) => !there.has(c.name)).map((c) => c.name);
    const rows = await q(src.db, `select ${cols.map((c) => ident(c.name)).join(", ")} from public.${ident(t)}`);
    const always = cols.some((c) => c.identity === "a") ? " overriding system value" : "";
    const per = Math.max(1, Math.min(500, Math.floor(60000 / Math.max(1, cols.length))));
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      const params = [];
      const values = chunk.map((r) => `(${cols.map((c) => { params.push(r[c.name]); return `$${params.length}`; }).join(", ")})`);
      await dst.db.query(`insert into public.${ident(t)} (${cols.map((c) => ident(c.name)).join(", ")})${always} values ${values.join(", ")}`, params);
    }
    report.push({ t, n: rows.length, missing });
    process.stdout.write(`  ${t}: ${rows.length}\n`);
  }
  for (const t of tables) await dst.db.query(`alter table public.${ident(t)} enable trigger user`);
  for (const k of fks) {
    try {
      await dst.db.query(`alter table ${k.tbl} add constraint ${ident(k.name)} ${k.def}`);
    } catch (e) {
      throw new Error(`the copied rows don't fit a link between tables (${k.tbl}: ${k.name}): ${e.message}`);
    }
  }
  // numbered columns carry on after the copied rows
  const seqs = await q(dst.db,
    `select c.relname as tbl, a.attname as col, pg_get_serial_sequence('public.' || quote_ident(c.relname), a.attname) as seq
       from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and pg_get_serial_sequence('public.' || quote_ident(c.relname), a.attname) is not null`);
  for (const s of seqs) {
    await dst.db.query(`select setval($1, coalesce((select max(${ident(s.col)}) from public.${ident(s.tbl)}), 0) + 1, false)`, [s.seq]);
  }
  await dst.db.query("commit");
  } catch (e) {
    await dst.db.query("rollback").catch(() => {});
    fail(`Copying stopped: ${e.message}. The target's rows were left as before.`);
  }

  console.log("4 · Checking");
  let bad = 0;
  for (const { t, missing } of report) {
    const [{ a }] = await q(src.db, `select count(*) as a from public.${ident(t)}`);
    const [{ b }] = await q(dst.db, `select count(*) as b from public.${ident(t)}`);
    if (a !== b) { bad++; console.log(`  ✗ ${t}: ${a} there, ${b} here`); }
    if (missing.length) console.log(`  · ${t}: new columns not in the source, left at their defaults: ${missing.join(", ")}`);
  }
  if (onlySrc.length) console.log(`  · Only in the source (not part of Pulse's tables, not copied): ${onlySrc.join(", ")}`);
  const total = report.reduce((s, r) => s + r.n, 0);
  if (bad) fail(`${bad} table(s) don't match. Run it again with --replace.`);
  console.log(`\n✓ Done: ${report.length} tables, ${total} rows, every count matches.`);
  console.log("Next: on Render, set DATABASE_URL to the target's address, ending in ?sslmode=no-verify instead of ?sslmode=require.");
} finally {
  await src.db.end().catch(() => {});
  await dst.db.end().catch(() => {});
}
