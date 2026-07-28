import { pool } from "./db.js";

// Append an event to the org's activity feed. Fire-and-forget: a logging
// failure must NEVER break the primary write that triggered it, so every call
// is wrapped and errors are only logged. Pass a transaction client as `db` to
// enlist in an existing transaction; otherwise it uses the shared pool.
export async function logActivity(
  { orgId, actorId, verb, entityType, entityId = null, channelId = null, summary, meta = {} },
  db = pool,
) {
  if (!orgId || !verb || !entityType || !summary) return;
  try {
    await db.query(
      `insert into activity (org_id, actor_id, verb, entity_type, entity_id, channel_id, summary, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, actorId ?? null, verb, entityType, entityId, channelId, summary, meta],
    );
  } catch (err) {
    console.error("logActivity failed:", err.message);
  }
}
