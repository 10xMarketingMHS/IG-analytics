// Adds post.collab_channel_id and copies doctorfarmer's taxonomy
// (pillars/avatars/content-types/formats) into the other channels so the bulk
// Add-Post form has options for every channel. Idempotent (copies by name).
import "dotenv/config";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const q = (sql, p = []) => client.query(sql, p);

try {
  await q("begin");

  // 1. collab column
  await q(
    "alter table public.post add column if not exists collab_channel_id uuid references public.workspace(id) on delete set null",
  );
  await q("create index if not exists post_collab_idx on public.post(collab_channel_id)");

  // 2. taxonomy copy: doctorfarmer → the rest
  const src = (await q("select id from workspace where name = 'doctorfarmer'")).rows[0].id;
  const targets = (
    await q("select id, name from workspace where org_id is not null and name <> 'doctorfarmer'")
  ).rows;

  const sp = (await q("select id, name, sort_order from pillar where workspace_id = $1", [src])).rows;
  const sa = (await q("select id, name, sort_order from avatar where workspace_id = $1", [src])).rows;
  const sct = (await q("select pillar_id, name from content_type where workspace_id = $1", [src])).rows;
  const sf = (await q("select pillar_id, name, post_type from format where workspace_id = $1", [src])).rows;
  const pillarName = new Map(sp.map((p) => [p.id, p.name]));

  for (const t of targets) {
    const tp = new Map(
      (await q("select id, name from pillar where workspace_id = $1", [t.id])).rows.map((r) => [r.name, r.id]),
    );
    for (const p of sp) {
      if (!tp.has(p.name)) {
        const r = await q(
          "insert into pillar (workspace_id, name, sort_order) values ($1,$2,$3) returning id",
          [t.id, p.name, p.sort_order],
        );
        tp.set(p.name, r.rows[0].id);
      }
    }
    const ta = new Set((await q("select name from avatar where workspace_id = $1", [t.id])).rows.map((r) => r.name));
    for (const a of sa) {
      if (!ta.has(a.name)) await q("insert into avatar (workspace_id, name, sort_order) values ($1,$2,$3)", [t.id, a.name, a.sort_order]);
    }
    const tct = new Set((await q("select name from content_type where workspace_id = $1", [t.id])).rows.map((r) => r.name));
    for (const ct of sct) {
      if (tct.has(ct.name)) continue;
      const pid = tp.get(pillarName.get(ct.pillar_id));
      if (pid) await q("insert into content_type (workspace_id, pillar_id, name) values ($1,$2,$3)", [t.id, pid, ct.name]);
    }
    const tf = new Set((await q("select name from format where workspace_id = $1", [t.id])).rows.map((r) => r.name));
    for (const f of sf) {
      if (tf.has(f.name)) continue;
      const pid = tp.get(pillarName.get(f.pillar_id));
      if (pid) await q("insert into format (workspace_id, pillar_id, name, post_type) values ($1,$2,$3,$4)", [t.id, pid, f.name, f.post_type]);
    }
    console.log(`  taxonomy synced → ${t.name}`);
  }

  await q("commit");
  console.log("✅ committed");
  for (const t of [{ id: src, name: "doctorfarmer" }, ...targets]) {
    const [{ count: c }] = (await q("select count(*)::int as count from content_type where workspace_id = $1", [t.id])).rows;
    const [{ count: f }] = (await q("select count(*)::int as count from format where workspace_id = $1", [t.id])).rows;
    console.log(`  ${t.name}: content_types=${c} formats=${f}`);
  }
} catch (e) {
  await q("rollback").catch(() => {});
  console.error("❌ failed — rolled back:\n", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
