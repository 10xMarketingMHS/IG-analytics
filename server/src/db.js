import pg from "pg";
import { config } from "./config.js";

const { Pool, types } = pg;

// OID 1082 = Postgres `date`. node-pg's default parser builds a JS Date at
// local midnight, so serializing it back to JSON with toISOString() shifts
// it to the previous day in any timezone ahead of UTC (e.g. IST). Returning
// the raw "YYYY-MM-DD" string sidesteps timezone math entirely — this app
// never needs `date` as a Date object, only as a plain calendar date.
types.setTypeParser(1082, (value) => value);

// OID 20 = Postgres `bigint`. node-pg returns these as strings by default
// (a bigint can exceed Number.MAX_SAFE_INTEGER) but the metric columns
// here (views/likes/comments/shares/saves/reach) never realistically will,
// and the frontend types them as `number` — parse so JSON matches that.
types.setTypeParser(20, (value) => parseInt(value, 10));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Supabase's session-mode pooler caps the whole project at 15 clients. Render
  // does rolling deploys (old + new instance overlap briefly), so a single
  // instance must stay well under half of that — otherwise the new instance
  // can't get a connection and the deploy crashes with EMAXCONNSESSION.
  // Configurable via DB_POOL_MAX; default 5 → 2 overlapping instances = 10 < 15.
  max: Number(process.env.DB_POOL_MAX) || 5,
  // Release idle connections after a while so overlapping deploys / local dev
  // don't permanently hoard slots against the 15-client cap.
  idleTimeoutMillis: 60_000,
  keepAlive: true,
  connectionTimeoutMillis: 15000,
});

// A dead idle connection would otherwise crash the process; drop it instead.
pool.on("error", () => {});

// Keep a handful of connections warm so parallel page-loads don't each pay the
// cold-connect penalty, and so the remote pooler doesn't idle them out.
async function warm(n = 4) {
  await Promise.allSettled(
    Array.from({ length: n }, () => pool.query("select 1")),
  );
}
warm();
setInterval(warm, 30_000).unref();
