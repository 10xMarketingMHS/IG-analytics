import crypto from "node:crypto";
import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Connected apps (20261106120000_ad_uploads; Settings › Connected apps):
// another app connects to one Ads team with one line Echo makes —
//   https://<echo>/api/animus#ec1.<connection id>.<secret>
// — pasted into that app once. Everything after "#" is the token: the app
// sends it in a header (x-echo-token), so the secret never sits in a URL or a
// server log. Echo keeps only a fingerprint of the secret, shows the line once,
// and revoking a connection ends it at once.

export const connectionsReady = () => hasColumn("app_connection", "secret_hash");
const fingerprint = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");

// A new connection's token: its id and a fresh secret.
export function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}
export const tokenOf = (id, secret) => `ec1.${id}.${secret}`;
export const secretHash = fingerprint;

// The live connection a token belongs to, or null (malformed, unknown, revoked
// or the wrong secret). Marks it used, at most every five minutes.
export async function connectionOf(token) {
  const m = String(token ?? "").trim().match(/^ec1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/);
  if (!m || !(await connectionsReady())) return null;
  const { rows } = await pool.query(
    `select c.id, c.org_id, c.ad_team_id, c.workspace_id, c.app, c.label, c.secret_hash, c.last_used_at,
            coalesce(tm.name, w.name) as team_name
       from app_connection c left join ad_team tm on tm.id = c.ad_team_id left join workspace w on w.id = c.workspace_id
      where c.id = $1 and c.revoked_at is null and (tm.id is null or tm.active)`,
    [m[1]],
  );
  const c = rows[0];
  if (!c) return null;
  const a = Buffer.from(fingerprint(m[2]), "hex"), b = Buffer.from(c.secret_hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!c.last_used_at || Date.now() - new Date(c.last_used_at).getTime() > 5 * 60_000) {
    await pool.query("update app_connection set last_used_at = now() where id = $1", [c.id]).catch(() => {});
  }
  return c;
}
