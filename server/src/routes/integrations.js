import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { config } from "../config.js";
import { requireEditor } from "../resolve-workspace.js";
import { requirePermission } from "../permissions.js";
import { encryptToken, decryptToken, encryptionReady, signState, verifyState } from "../crypto.js";
import { logActivity } from "../activity.js";
import * as ig from "../integrations/instagram.js";
import * as yt from "../integrations/youtube.js";
import * as fb from "../integrations/facebook.js";

// Upsert a platform_connection row (one per account × provider). Used by every
// connect path so the shape stays identical across Instagram / Facebook / YouTube.
async function upsertConnection({ orgId, accountId, provider, externalId, externalName, tokenEnc, scope, uid, followers = null }) {
  await pool.query(
    `insert into platform_connection
       (org_id, account_id, provider, external_id, external_name, access_token_enc, token_expires_at, scope, connected_by, follower_count)
     values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9)
     on conflict (account_id, provider) do update set
       external_id = excluded.external_id, external_name = excluded.external_name,
       access_token_enc = excluded.access_token_enc, token_expires_at = null,
       scope = excluded.scope, connected_by = excluded.connected_by,
       follower_count = excluded.follower_count, connected_at = now()`,
    [orgId, accountId, provider, externalId, externalName, tokenEnc, scope ?? null, uid, followers],
  );
}

// The org's YouTube Data API key: the admin-entered, encrypted DB key first,
// falling back to a server env var if one was ever set. null = not configured.
async function getYoutubeKey(orgId) {
  const row = (await pool.query("select youtube_api_key_enc from org where id = $1", [orgId])).rows[0];
  if (row?.youtube_api_key_enc) {
    try { return decryptToken(row.youtube_api_key_enc); } catch { /* fall through to env */ }
  }
  return yt.apiKey() || null;
}

// Shared Meta auto-save: when an Instagram connect succeeds, the same Meta auth
// already carries the linked Facebook Page (ig.listIgAccounts returns pageId /
// pageName / pageToken). If this channel has a Facebook account too, save its
// connection as well — independent row, independently disconnectable. Returns the
// Page name that got connected (for a toast), or null.
async function autoSaveFacebook(orgId, channelId, page, uid) {
  if (!page?.pageId) return null;
  const fbAcc = (await pool.query(
    `select a.id from account a join platform p on p.id = a.platform_id
      where a.workspace_id = $1 and a.org_id = $2 and p.key = 'facebook'`,
    [channelId, orgId],
  )).rows[0];
  if (!fbAcc) return null;
  // Store the Page token encrypted; fall back to the 'SYSTEM' sentinel (resolve
  // the Page token from the system token at sync time) when no encryption key.
  const tokenEnc = encryptionReady() && page.pageToken ? encryptToken(page.pageToken) : "SYSTEM";
  let followers = null;
  try { followers = await fb.getPageFollowers(page.pageId, page.pageToken); } catch { /* best-effort */ }
  await upsertConnection({
    orgId, accountId: fbAcc.id, provider: "facebook",
    externalId: page.pageId, externalName: page.pageName, tokenEnc, scope: ig.SCOPES.join(","), uid, followers,
  });
  return page.pageName;
}

export const integrationsRouter = Router();

// Where to send the browser back to after an OAuth round trip. Prod is single
// origin; in dev the SPA lives on the CORS origin (:3000).
function frontendBase() {
  return config.NODE_ENV === "production" ? config.APP_BASE_URL : config.CORS_ORIGIN;
}
// Integrations UI now lives inside the Channels page — send OAuth callbacks there.
function backToIntegrations(res, query) {
  res.redirect(`${frontendBase()}/channels?${new URLSearchParams(query).toString()}`);
}

// Setup readiness — drives the Integrations page's "what to do next" state.
// Two ways to connect: a System User token (one click, never expires) or the
// OAuth app flow. System token wins when both are present.
integrationsRouter.get("/integrations/status", async (req, res, next) => {
  try {
  const encryption = encryptionReady();
  const systemToken = ig.systemTokenConfigured();
  const oauth = ig.metaConfigured() && encryption;
  // Per-account tokens can be pasted & stored whenever encryption is available.
  const pasteToken = encryption;
  // YouTube is ready when the org has an in-app key (or a legacy env key).
  const ytKey = await getYoutubeKey(req.orgId);
  res.json({
    instagram: {
      configured: ig.metaConfigured(),
      encryption,
      systemToken,
      pasteToken,
      method: systemToken ? "system" : oauth ? "oauth" : null,
      ready: systemToken || oauth || pasteToken,
    },
    // Facebook shares the Meta app/OAuth with Instagram, so its readiness is the
    // same — it just connects a Page instead of an IG account.
    facebook: {
      configured: ig.metaConfigured(),
      encryption,
      systemToken,
      pasteToken,
      ready: systemToken || oauth || pasteToken,
    },
    // YouTube (Y-A): ready once an admin has stored the org's API key in-app.
    // `hasKey` distinguishes "key set" from the encryption prerequisite so the
    // UI can show the key-entry step vs the channel-connect step.
    youtube: {
      configured: !!ytKey,
      ready: !!ytKey,
      encryption,
    },
  });
  } catch (err) { next(err); }
});

// All connections in the org, joined to their account/channel/platform. Tokens
// are never returned.
integrationsRouter.get("/integrations/connections", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select c.id, c.provider, c.external_id, c.external_name, c.token_expires_at,
              c.connected_at, c.last_synced_at, c.last_sync_status, c.follower_count,
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
integrationsRouter.get("/integrations/instagram/connect", requirePermission("channels"), async (req, res, next) => {
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
    const fbPage = await autoSaveFacebook(state.orgId, acct.workspace_id, chosen, state.uid);

    await logActivity({
      orgId: state.orgId, actorId: state.uid, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Instagram @${chosen.igUsername}`,
    });
    backToIntegrations(res, fbPage ? { connected: "instagram", facebook: fbPage } : { connected: "instagram" });
  } catch (err) {
    console.error("IG callback failed:", err.message);
    backToIntegrations(res, { error: "exchange_failed" });
  }
});

// One-click connect using the server's System User token — no OAuth. Discovers
// the Instagram account the token can see and links it to the Pulse account.
// Stores the sentinel 'SYSTEM' instead of a token (the token lives in env).
const ConnectSchema = z.object({ accountId: z.string().uuid() });
integrationsRouter.post("/integrations/instagram/connect-system", requirePermission("channels"), async (req, res, next) => {
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
    // Shared Meta: the linked Facebook Page came back with this IG account — if
    // this channel also has Facebook on, connect it too (independent row).
    const fbPage = await autoSaveFacebook(req.orgId, acct.workspace_id, chosen, req.user.sub);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Instagram @${chosen.igUsername}`,
    });
    res.status(201).json({ ok: true, handle: "@" + chosen.igUsername, facebookPage: fbPage });
  } catch (err) {
    next(err);
  }
});

// Per-account token: the admin pastes a token for THIS specific account (e.g. a
// second brand under a different system user). Validated, then stored ENCRYPTED
// in the DB — so every account can carry its own token, no shared env var.
const ConnectTokenSchema = z.object({ accountId: z.string().uuid(), token: z.string().min(20) });
integrationsRouter.post("/integrations/instagram/connect-token", requirePermission("channels"), async (req, res, next) => {
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
    const fbPage = await autoSaveFacebook(req.orgId, acct.workspace_id, chosen, req.user.sub);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Instagram @${chosen.igUsername}`,
    });
    res.status(201).json({ ok: true, handle: "@" + chosen.igUsername, facebookPage: fbPage });
  } catch (err) {
    next(err);
  }
});

const SyncSchema = z.object({ accountId: z.string().uuid() });

// ===== Facebook (Meta Page) — its own connection, shares the Meta OAuth =====

// One-click Facebook connect via the server system token. Picks the Page (by the
// channel's handle, else the only one) and stores its own connection row.
integrationsRouter.post("/integrations/facebook/connect-system", requirePermission("channels"), async (req, res, next) => {
  const parsed = ConnectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId is required" });
  if (!ig.systemTokenConfigured()) {
    return res.status(400).json({ error: "No system token configured on the server (set META_SYSTEM_TOKEN)." });
  }
  try {
    const acct = (await pool.query(
      `select a.id, a.handle, a.workspace_id from account a join platform p on p.id = a.platform_id
        where a.id = $1 and a.org_id = $2 and p.key = 'facebook'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Unknown Facebook account" });

    let pages;
    try { pages = await fb.listPages(ig.systemToken()); }
    catch (err) { return res.status(502).json({ error: `Meta token error: ${err.message}` }); }
    if (!pages.length) return res.status(400).json({ error: "The system token can't see any Facebook Pages. Check its assigned assets & permissions." });

    const handle = (acct.handle || "").replace(/^@/, "").toLowerCase();
    const chosen = pages.find((p) => p.pageName?.toLowerCase() === handle) || (pages.length === 1 ? pages[0] : null);
    if (!chosen) {
      return res.status(409).json({ error: `The token sees ${pages.length} Pages (${pages.map((p) => p.pageName).join(", ")}). Set this channel's handle to match a Page, then retry.` });
    }
    const tokenEnc = encryptionReady() && chosen.pageToken ? encryptToken(chosen.pageToken) : "SYSTEM";
    await upsertConnection({
      orgId: req.orgId, accountId: acct.id, provider: "facebook",
      externalId: chosen.pageId, externalName: chosen.pageName, tokenEnc, scope: ig.SCOPES.join(","), uid: req.user.sub, followers: chosen.followers,
    });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Facebook Page ${chosen.pageName}`,
    });
    res.status(201).json({ ok: true, page: chosen.pageName });
  } catch (err) { next(err); }
});

// Per-account Facebook connect via a pasted token — stores the resolved Page token.
integrationsRouter.post("/integrations/facebook/connect-token", requirePermission("channels"), async (req, res, next) => {
  const parsed = ConnectTokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId and a token are required" });
  if (!encryptionReady()) {
    return res.status(400).json({ error: "Server encryption key isn't set (APP_ENCRYPTION_KEY) — can't store a token securely." });
  }
  try {
    const acct = (await pool.query(
      `select a.id, a.handle, a.workspace_id from account a join platform p on p.id = a.platform_id
        where a.id = $1 and a.org_id = $2 and p.key = 'facebook'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Unknown Facebook account" });

    let pages;
    try { pages = await fb.listPages(parsed.data.token); }
    catch (err) { return res.status(502).json({ error: `Meta token error: ${err.message}` }); }
    if (!pages.length) return res.status(400).json({ error: "This token can't see any Facebook Pages. Check its assigned assets & permissions." });

    const handle = (acct.handle || "").replace(/^@/, "").toLowerCase();
    const chosen = pages.find((p) => p.pageName?.toLowerCase() === handle) || (pages.length === 1 ? pages[0] : null);
    if (!chosen) {
      return res.status(409).json({ error: `This token sees ${pages.length} Pages (${pages.map((p) => p.pageName).join(", ")}). Set this channel's handle to match a Page, then retry.` });
    }
    await upsertConnection({
      orgId: req.orgId, accountId: acct.id, provider: "facebook",
      externalId: chosen.pageId, externalName: chosen.pageName,
      tokenEnc: encryptToken(chosen.pageToken || parsed.data.token), scope: ig.SCOPES.join(","), uid: req.user.sub, followers: chosen.followers,
    });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected Facebook Page ${chosen.pageName}`,
    });
    res.status(201).json({ ok: true, page: chosen.pageName });
  } catch (err) { next(err); }
});

// Facebook sync — Option 2: only likes (reactions total) / comments / shares +
// Page followers. Views & reach are intentionally NOT written (Meta's impression
// metrics are deprecated and the media-view replacements aren't comparable to IG).
integrationsRouter.post("/integrations/facebook/sync", requireEditor, async (req, res, next) => {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId is required" });
  try {
    const conn = (await pool.query(
      `select c.id, c.external_id, c.access_token_enc, a.workspace_id, a.platform_id
         from platform_connection c join account a on a.id = c.account_id
        where c.account_id = $1 and c.org_id = $2 and c.provider = 'facebook'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!conn) return res.status(404).json({ error: "This channel isn't connected to Facebook yet." });

    // Resolve the Page token: 'SYSTEM' → look it up via the system token.
    let pageToken;
    if (conn.access_token_enc === "SYSTEM") {
      if (!ig.systemTokenConfigured()) return res.status(400).json({ error: "This connection uses the system token, but META_SYSTEM_TOKEN isn't set." });
      const page = (await fb.listPages(ig.systemToken())).find((p) => p.pageId === conn.external_id);
      if (!page) return res.status(502).json({ error: "The system token can no longer see this Page." });
      pageToken = page.pageToken;
    } else {
      pageToken = decryptToken(conn.access_token_enc);
    }

    const posts = (await pool.query(
      `select id, permalink from post
        where workspace_id = $1 and platform_id = $2 and deleted_at is null
          and permalink is not null and is_collab_mirror = false`,
      [conn.workspace_id, conn.platform_id],
    )).rows;

    let map;
    try { map = await fb.listPostsByPermalink(conn.external_id, pageToken); }
    catch (err) {
      await pool.query("update platform_connection set last_synced_at = now(), last_sync_status = $2 where id = $1", [conn.id, `Failed: ${err.message.slice(0, 120)}`]);
      return res.status(502).json({ error: `Facebook API error: ${err.message}` });
    }

    let updated = 0, matched = 0;
    for (const post of posts) {
      const m = map.get(fb.normalizePermalink(post.permalink));
      if (!m) continue;
      matched += 1;
      const met = await fb.getPostMetrics(m.id, pageToken);
      await pool.query(
        `update post set likes = $2, comments = $3, shares = $4, external_id = $5,
                last_synced_at = now(), metrics_updated_at = now() where id = $1`,
        [post.id, met.likes, met.comments, met.shares, m.id],
      );
      updated += 1;
    }
    const followers = await fb.getPageFollowers(conn.external_id, pageToken);
    const status = `Synced ${updated}/${posts.length} post${posts.length === 1 ? "" : "s"}`;
    await pool.query(
      "update platform_connection set last_synced_at = now(), last_sync_status = $2, follower_count = coalesce($3, follower_count) where id = $1",
      [conn.id, status, followers],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "published",
      entityType: "channel", entityId: conn.workspace_id, channelId: conn.workspace_id,
      summary: `Synced ${updated} post${updated === 1 ? "" : "s"} from Facebook`,
    });
    res.json({ ok: true, total: posts.length, matched, updated, unmatched: posts.length - matched });
  } catch (err) { next(err); }
});

// ===== YouTube API key (org-wide, admin-entered, stored encrypted in-app) =====
// Set/replace the org's YouTube key — validated with a real call before storing,
// so a bad key fails visibly and is never saved. Admin-only.
const YtKeySchema = z.object({ key: z.string().min(10) });
integrationsRouter.post("/integrations/youtube/key", requirePermission("channels"), async (req, res, next) => {
  const parsed = YtKeySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A YouTube API key is required." });
  if (!encryptionReady()) {
    return res.status(400).json({ error: "Server encryption key isn't set (APP_ENCRYPTION_KEY) — can't store the key securely." });
  }
  try {
    try { await yt.validateKey(parsed.data.key); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    await pool.query("update org set youtube_api_key_enc = $2 where id = $1", [req.orgId, encryptToken(parsed.data.key.trim())]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});
// Remove the org's YouTube key (channels stay connected but can't sync until a
// new key is set). Admin-only.
integrationsRouter.delete("/integrations/youtube/key", requirePermission("channels"), async (req, res, next) => {
  try {
    await pool.query("update org set youtube_api_key_enc = null where id = $1", [req.orgId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ===== YouTube connect (Y-A) — resolve a channel via the org key, no OAuth =====
const YtConnectSchema = z.object({ accountId: z.string().uuid(), channel: z.string().min(1) });
integrationsRouter.post("/integrations/youtube/connect", requirePermission("channels"), async (req, res, next) => {
  const parsed = YtConnectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId and a channel URL/handle are required" });
  const ytKey = await getYoutubeKey(req.orgId);
  if (!ytKey) return res.status(400).json({ error: "Add your YouTube API key first (admin) — then connect channels." });
  try {
    const acct = (await pool.query(
      `select a.id, a.workspace_id from account a join platform p on p.id = a.platform_id
        where a.id = $1 and a.org_id = $2 and p.key = 'youtube'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Unknown YouTube account" });

    // Resolve or FAIL VISIBLY — never store a connection to nothing.
    let ch;
    try { ch = await yt.resolveChannel(parsed.data.channel, ytKey); }
    catch (err) { return res.status(err.status || 502).json({ error: err.message }); }

    await upsertConnection({
      orgId: req.orgId, accountId: acct.id, provider: "youtube",
      externalId: ch.channelId, externalName: ch.title, tokenEnc: "PUBLIC", scope: null, uid: req.user.sub, followers: ch.subscribers,
    });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "channel_added",
      entityType: "channel", entityId: acct.workspace_id, channelId: acct.workspace_id,
      summary: `Connected YouTube ${ch.title}`,
    });
    res.status(201).json({ ok: true, channel: ch.title });
  } catch (err) { next(err); }
});

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
    // Collab mirrors are skipped here — the collab media lives on the OWNER's
    // account (not this one), so it wouldn't match anyway; its metrics are
    // copied from the owner below.
    const posts = (await pool.query(
      `select id, permalink, collab_group_id from post
        where workspace_id = $1 and platform_id = $2 and deleted_at is null
          and permalink is not null and is_collab_mirror = false`,
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
      // Copy the same numbers onto any collab mirror(s) of this post so the
      // collaborating channel can display them (they never count toward
      // performance aggregates — the mirror flag excludes them client-side).
      if (post.collab_group_id) {
        await pool.query(
          `update post set views=$2, reach=$3, likes=$4, comments=$5, shares=$6, saves=$7,
                  last_synced_at=now(), metrics_updated_at=now()
            where collab_group_id=$1 and is_collab_mirror = true and deleted_at is null`,
          [post.collab_group_id, m.views, m.reach, m.likes, m.comments, m.shares, m.saves],
        );
      }
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

// YouTube Tier 1 sync: refresh public view/like/comment counts on this channel's
// YouTube posts by matching the video id in each post's Link, plus the channel's
// subscriber count. No connection/token — just the org-wide API key. Same
// refresh-only, on-demand pattern as the Instagram sync above.
integrationsRouter.post("/integrations/youtube/sync", requireEditor, async (req, res, next) => {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId is required" });
  const ytKey = await getYoutubeKey(req.orgId);
  if (!ytKey) return res.status(400).json({ error: "No YouTube API key set — an admin needs to add one." });
  try {
    const conn = (await pool.query(
      `select c.id, c.external_id, a.workspace_id, a.platform_id
         from platform_connection c join account a on a.id = c.account_id
        where c.account_id = $1 and c.org_id = $2 and c.provider = 'youtube'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!conn) return res.status(404).json({ error: "This channel isn't connected to YouTube yet." });

    const posts = (await pool.query(
      `select id, permalink from post
        where workspace_id = $1 and platform_id = $2 and deleted_at is null
          and permalink is not null and is_collab_mirror = false`,
      [conn.workspace_id, conn.platform_id],
    )).rows;

    // video id -> [post ids that link to it]
    const idToPosts = new Map();
    for (const p of posts) {
      const vid = yt.extractVideoId(p.permalink);
      if (!vid) continue;
      if (!idToPosts.has(vid)) idToPosts.set(vid, []);
      idToPosts.get(vid).push(p.id);
    }
    const videoIds = [...idToPosts.keys()];

    let stats;
    try {
      stats = await yt.fetchVideoStats(videoIds, ytKey);
    } catch (err) {
      await pool.query("update platform_connection set last_synced_at = now(), last_sync_status = $2 where id = $1",
        [conn.id, `Failed: ${err.message.slice(0, 120)}`]);
      return res.status(502).json({ error: `YouTube API error: ${err.message}` });
    }

    let updated = 0;
    let matched = 0;
    for (const [vid, postIds] of idToPosts) {
      const s = stats.get(vid);
      if (!s) continue;
      matched += postIds.length;
      for (const pid of postIds) {
        // Tier 1 exposes views/likes/comments only — leave reach/shares/saves
        // untouched (YouTube has no public equivalent; don't zero them out).
        await pool.query(
          `update post set views = $2, likes = $3, comments = $4,
                  last_synced_at = now(), metrics_updated_at = now()
            where id = $1`,
          [pid, s.views, s.likes, s.comments],
        );
        updated += 1;
      }
    }

    // Refresh the connected channel's subscriber count (best-effort — we know the
    // channel id from the connection, so this works even if no videos matched).
    let subscribers = null;
    try {
      const ch = await yt.fetchChannelStats([conn.external_id], ytKey);
      subscribers = ch.get(conn.external_id)?.subscribers ?? null;
    } catch { /* subscriber count is optional */ }

    const status = `Synced ${updated}/${posts.length} video${posts.length === 1 ? "" : "s"}`;
    await pool.query(
      "update platform_connection set last_synced_at = now(), last_sync_status = $2, follower_count = coalesce($3, follower_count) where id = $1",
      [conn.id, status, subscribers],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "published",
      entityType: "channel", entityId: conn.workspace_id, channelId: conn.workspace_id,
      summary: `Synced ${updated} video${updated === 1 ? "" : "s"} from YouTube`,
    });

    res.json({ ok: true, total: posts.length, matched, updated, unmatched: posts.length - matched, subscribers });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.delete("/integrations/connections/:id", requirePermission("channels"), async (req, res, next) => {
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
