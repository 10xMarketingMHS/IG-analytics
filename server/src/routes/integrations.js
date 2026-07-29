import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { config } from "../config.js";
import { requireAdmin, requireEditor } from "../resolve-workspace.js";
import { encryptToken, decryptToken, encryptionReady, signState, verifyState } from "../crypto.js";
import { logActivity } from "../activity.js";
import * as ig from "../integrations/instagram.js";

export const integrationsRouter = Router();

// Where to send the browser back to after an OAuth round trip. Prod is single
// origin; in dev the SPA lives on the CORS origin (:3000).
function frontendBase() {
  return config.NODE_ENV === "production" ? config.APP_BASE_URL : config.CORS_ORIGIN;
}
function backToIntegrations(res, query) {
  res.redirect(`${frontendBase()}/integrations?${new URLSearchParams(query).toString()}`);
}

// Setup readiness — drives the Integrations page's "what to do next" state.
// Two ways to connect: a System User token (one click, never expires) or the
// OAuth app flow. System token wins when both are present.
integrationsRouter.get("/integrations/status", (_req, res) => {
  const encryption = encryptionReady();
  const systemToken = ig.systemTokenConfigured();
  const oauth = ig.metaConfigured() && encryption;
  // Per-account tokens can be pasted & stored whenever encryption is available.
  const pasteToken = encryption;
  res.json({
    instagram: {
      configured: ig.metaConfigured(),
      encryption,
      systemToken,
      pasteToken,
      method: systemToken ? "system" : oauth ? "oauth" : null,
      ready: systemToken || oauth || pasteToken,
    },
  });
});

// All connections in the org, joined to their account/channel/platform. Tokens
// are never returned.
integrationsRouter.get("/integrations/connections", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select c.id, c.provider, c.external_id, c.external_name, c.token_expires_at,
              c.connected_at, c.last_synced_at, c.last_sync_status,
              c.account_id, a.workspace_id as channel_id, w.name as channel_name,
              p.key as platform_key, p.name as platform_name
         from platform_connection c
         join account a on a.id = c.account_id
         join workspace w on w.id = a.workspace_id
         join platform p on p.id = a.platform_id
        where c.org_id = $1
        order by w.name`,
      [req.orgId],
    );
    res.json({ connections: rows });
  } catch (err) {
    next(err);
  }
});

// Step 1: start OAuth for a specific Pulse account (channel × Instagram).
integrationsRouter.get("/integrations/instagram/connect", requireAdmin, async (req, res, next) => {
  try {
    if (!ig.metaConfigured()) return backToIntegrations(res, { error: "not_configured" });
    if (!encryptionReady()) return backToIntegrations(res, { error: "no_encryption" });
    const accountId = req.query.accountId;
    // Validate the account is an Instagram account in this org.
    const { rows } = await pool.query(
      `select a.id from account a join platform p on p.id = a.platform_id
        where a.id = $1 and a.org_id = $2 and p.key = 'instagram'`,
      [accountId, req.orgId],
    );
    if (!rows.length) return backToIntegrations(res, { error: "bad_account" });

    const state = signState({ accountId, orgId: req.orgId, uid: req.user.sub, exp: Date.now() + 10 * 60 * 1000 });
    res.redirect(ig.authUrl(state));
  } catch (err) {
    next(err);
  }
});

// Step 2: OAuth callback — exchange the code, find the linked IG account, store
// an encrypted long-lived token.
integrationsRouter.get("/integrations/instagram/callback", async (req, res, next) => {
  try {
    if (req.query.error) return backToIntegrations(res, { error: "denied" });
    const state = verifyState(req.query.state);
    if (!state || state.uid !== req.user.sub) return backToIntegrations(res, { error: "bad_state" });

    // Re-validate the target account still belongs to the org.
    const acct = (await pool.query(
      `select a.id, a.handle, a.workspace_id, a.platform_id
         from account a join platform p on p.id = a.platform_id
        where a.id = $1 and a.org_id = $2 and p.key = 'instagram'`,
      [state.accountId, state.orgId],
    )).rows[0];
    if (!acct) return backToIntegrations(res, { error: "bad_account" });

    const { token: userToken, expiresIn } = await ig.exchangeCode(req.query.code);
    const accounts = await ig.listIgAccounts(userToken);
    if (accounts.length === 0) return backToIntegrations(res, { error: "no_ig" });

    // Pick the IG account: match the Pulse account's handle, else the only one.
    const handle = (acct.handle || "").replace(/^@/, "").toLowerCase();
    const chosen = accounts.find((a) => a.igUsername?.toLowerCase() === handle)
      || (accounts.length === 1 ? accounts[0] : null);
    if (!chosen) return backToIntegrations(res, { error: "pick_needed" });

    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
    await pool.query(
      `insert into platform_connection
         (org_id, account_id, provider, external_id, external_name, access_token_enc, token_expires_at, scope, connected_by)
       values ($1,$2,'instagram',$3,$4,$5,$6,$7,$8)
       on conflict (account_id, provider) do update set
         external_id = excluded.external_id, external_name = excluded.external_name,
         access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at,
         scope = excluded.scope, connected_by = excluded.connected_by, connected_at = now()`,
      [state.orgId, acct.id, chosen.igId, "@" + chosen.igUsername, encryptToken(chosen.pageToken), expiresAt, ig.SCOPES.join(","), state.uid],
    );

    await logActivity({
      orgId: state.orgId, actorId: state.uid, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Instagram @${chosen.igUsername}`,
    });
    backToIntegrations(res, { connected: "instagram" });
  } catch (err) {
    console.error("IG callback failed:", err.message);
    backToIntegrations(res, { error: "exchange_failed" });
  }
});

// One-click connect using the server's System User token — no OAuth. Discovers
// the Instagram account the token can see and links it to the Pulse account.
// Stores the sentinel 'SYSTEM' instead of a token (the token lives in env).
const ConnectSchema = z.object({ accountId: z.string().uuid() });
integrationsRouter.post("/integrations/instagram/connect-system", requireAdmin, async (req, res, next) => {
  const parsed = ConnectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId is required" });
  if (!ig.systemTokenConfigured()) {
    return res.status(400).json({ error: "No system token configured on the server (set META_SYSTEM_TOKEN)." });
  }
  try {
    const acct = (await pool.query(
      `select a.id, a.handle, a.workspace_id from account a
       join platform p on p.id = a.platform_id
       where a.id = $1 and a.org_id = $2 and p.key = 'instagram'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Unknown Instagram account" });

    let accounts;
    try {
      accounts = await ig.listIgAccounts(ig.systemToken());
    } catch (err) {
      return res.status(502).json({ error: `Meta token error: ${err.message}` });
    }
    if (!accounts.length) {
      return res.status(400).json({ error: "The system token can't see any Instagram Business accounts. Check the token's assigned assets & permissions." });
    }

    // Match by handle, else use the only one available.
    const handle = (acct.handle || "").replace(/^@/, "").toLowerCase();
    const chosen = accounts.find((a) => a.igUsername?.toLowerCase() === handle)
      || (accounts.length === 1 ? accounts[0] : null);
    if (!chosen) {
      return res.status(409).json({
        error: `The token sees ${accounts.length} IG accounts (${accounts.map((a) => "@" + a.igUsername).join(", ")}). Set this channel's handle to match one, then retry.`,
      });
    }

    await pool.query(
      `insert into platform_connection
         (org_id, account_id, provider, external_id, external_name, access_token_enc, token_expires_at, scope, connected_by)
       values ($1,$2,'instagram',$3,$4,'SYSTEM',null,$5,$6)
       on conflict (account_id, provider) do update set
         external_id = excluded.external_id, external_name = excluded.external_name,
         access_token_enc = 'SYSTEM', token_expires_at = null, scope = excluded.scope,
         connected_by = excluded.connected_by, connected_at = now()`,
      [req.orgId, acct.id, chosen.igId, "@" + chosen.igUsername, ig.SCOPES.join(","), req.user.sub],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Instagram @${chosen.igUsername}`,
    });
    res.status(201).json({ ok: true, handle: "@" + chosen.igUsername });
  } catch (err) {
    next(err);
  }
});

// Per-account token: the admin pastes a token for THIS specific account (e.g. a
// second brand under a different system user). Validated, then stored ENCRYPTED
// in the DB — so every account can carry its own token, no shared env var.
const ConnectTokenSchema = z.object({ accountId: z.string().uuid(), token: z.string().min(20) });
integrationsRouter.post("/integrations/instagram/connect-token", requireAdmin, async (req, res, next) => {
  const parsed = ConnectTokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId and a token are required" });
  if (!encryptionReady()) {
    return res.status(400).json({ error: "Server encryption key isn't set (APP_ENCRYPTION_KEY) — can't store a token securely." });
  }
  try {
    const acct = (await pool.query(
      `select a.id, a.handle, a.workspace_id from account a
       join platform p on p.id = a.platform_id
       where a.id = $1 and a.org_id = $2 and p.key = 'instagram'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Unknown Instagram account" });

    let accounts;
    try {
      accounts = await ig.listIgAccounts(parsed.data.token);
    } catch (err) {
      return res.status(502).json({ error: `Meta token error: ${err.message}` });
    }
    if (!accounts.length) {
      return res.status(400).json({ error: "This token can't see any Instagram Business accounts. Check its assigned assets & permissions." });
    }

    const handle = (acct.handle || "").replace(/^@/, "").toLowerCase();
    const chosen = accounts.find((a) => a.igUsername?.toLowerCase() === handle)
      || (accounts.length === 1 ? accounts[0] : null);
    if (!chosen) {
      return res.status(409).json({
        error: `This token sees ${accounts.length} IG accounts (${accounts.map((a) => "@" + a.igUsername).join(", ")}). Set this channel's handle to match one, then retry.`,
      });
    }

    await pool.query(
      `insert into platform_connection
         (org_id, account_id, provider, external_id, external_name, access_token_enc, token_expires_at, scope, connected_by)
       values ($1,$2,'instagram',$3,$4,$5,null,$6,$7)
       on conflict (account_id, provider) do update set
         external_id = excluded.external_id, external_name = excluded.external_name,
         access_token_enc = excluded.access_token_enc, token_expires_at = null,
         scope = excluded.scope, connected_by = excluded.connected_by, connected_at = now()`,
      [req.orgId, acct.id, chosen.igId, "@" + chosen.igUsername, encryptToken(parsed.data.token), ig.SCOPES.join(","), req.user.sub],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Instagram @${chosen.igUsername}`,
    });
    res.status(201).json({ ok: true, handle: "@" + chosen.igUsername });
  } catch (err) {
    next(err);
  }
});

const SyncSchema = z.object({ accountId: z.string().uuid() });

// Step 3: pull fresh metrics for the connected account's posts (match by Link).
integrationsRouter.post("/integrations/instagram/sync", requireEditor, async (req, res, next) => {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId is required" });
  try {
    const conn = (await pool.query(
      `select c.id, c.external_id, c.access_token_enc, a.workspace_id, a.platform_id
         from platform_connection c join account a on a.id = c.account_id
        where c.account_id = $1 and c.org_id = $2 and c.provider = 'instagram'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!conn) return res.status(404).json({ error: "This account isn't connected to Instagram yet." });

    // 'SYSTEM' means "use the server's system token" (stored in env, not the DB).
    let token;
    if (conn.access_token_enc === "SYSTEM") {
      if (!ig.systemTokenConfigured()) {
        return res.status(400).json({ error: "This connection uses the system token, but META_SYSTEM_TOKEN isn't set." });
      }
      token = ig.systemToken();
    } else {
      token = decryptToken(conn.access_token_enc);
    }
    // Every post on this channel × platform that has a Link to match against.
    const posts = (await pool.query(
      `select id, permalink from post
        where workspace_id = $1 and platform_id = $2 and deleted_at is null and permalink is not null`,
      [conn.workspace_id, conn.platform_id],
    )).rows;

    let mediaMap;
    try {
      mediaMap = await ig.listMediaByPermalink(conn.external_id, token);
    } catch (err) {
      await pool.query("update platform_connection set last_synced_at = now(), last_sync_status = $2 where id = $1",
        [conn.id, `Failed: ${err.message.slice(0, 120)}`]);
      return res.status(502).json({ error: `Instagram API error: ${err.message}` });
    }

    let updated = 0;
    let matched = 0;
    for (const post of posts) {
      const media = mediaMap.get(ig.normalizePermalink(post.permalink));
      if (!media) continue;
      matched += 1;
      const m = await ig.getMediaMetrics(media, token);
      await pool.query(
        `update post set views=$2, reach=$3, likes=$4, comments=$5, shares=$6, saves=$7,
                external_id=$8, last_synced_at=now(), metrics_updated_at=now()
          where id=$1`,
        [post.id, m.views, m.reach, m.likes, m.comments, m.shares, m.saves, media.id],
      );
      updated += 1;
    }

    const status = `Synced ${updated}/${posts.length} post${posts.length === 1 ? "" : "s"}`;
    await pool.query("update platform_connection set last_synced_at = now(), last_sync_status = $2 where id = $1", [conn.id, status]);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "published",
      entityType: "channel", entityId: conn.workspace_id, channelId: conn.workspace_id,
      summary: `Synced ${updated} post${updated === 1 ? "" : "s"} from Instagram`,
    });

    res.json({ ok: true, total: posts.length, matched, updated, unmatched: posts.length - matched });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.delete("/integrations/connections/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from platform_connection where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Connection not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
