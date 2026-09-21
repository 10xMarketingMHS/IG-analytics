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
  const { rows } = await pool.query(
    `insert into platform_connection
       (org_id, account_id, provider, external_id, external_name, access_token_enc, token_expires_at, scope, connected_by, follower_count)
     values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9)
     on conflict (account_id, provider) do update set
       external_id = excluded.external_id, external_name = excluded.external_name,
       access_token_enc = excluded.access_token_enc, token_expires_at = null,
       scope = excluded.scope, connected_by = excluded.connected_by,
       follower_count = excluded.follower_count, connected_at = now(),
       -- Reconnecting clears prior sync health, so a connection that was flagged
       -- 'needs reconnect' (permanent) actually resumes auto-sync after re-auth.
       last_error_type = null, consecutive_failures = 0, sync_in_progress = false
     returning id`,
    [orgId, accountId, provider, externalId, externalName, tokenEnc, scope ?? null, uid, followers],
  );
  captureFollowerSnapshots(rows[0]?.id).catch(() => {}); // record today's value right away
}

// Record today's follower_count for every connection into follower_snapshot —
// one row per connection per IST day (later captures the same day just refresh
// it). Builds the timeline the dashboard reads for range/growth. Idempotent.
// Record today's follower count into the timeline. Pass a connectionId to snapshot
// just that one connection (per-sync); omit it for the whole org (on connect).
// Scoping matters now that auto-poll runs this per connection every interval —
// an org-wide table scan on each poll would be wasted I/O against the pooler.
async function captureFollowerSnapshots(connectionId = null) {
  await pool.query(
    `insert into follower_snapshot (org_id, connection_id, provider, follower_count, day)
     select org_id, id, provider, follower_count, (now() at time zone 'Asia/Kolkata')::date
       from platform_connection
      where follower_count is not null and ($1::uuid is null or id = $1)
     on conflict (connection_id, day) do update set
       follower_count = excluded.follower_count, captured_at = now()`,
    [connectionId],
  );
}

// Keep the timeline ticking even without a reconnect/sync: capture once shortly
// after boot and every 6h. Idempotent per day, so overlapping instances are fine.
setTimeout(() => captureFollowerSnapshots().catch(() => {}), 15_000).unref();
setInterval(() => captureFollowerSnapshots().catch(() => {}), 6 * 60 * 60 * 1000).unref();

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
  // Never override an existing Facebook connection: the user may have explicitly
  // picked a specific Page for this channel. The IG-linked Page is only a
  // convenience for the FIRST connect — after that, respect their choice so the
  // channel keeps showing its own Page's data.
  const existing = (await pool.query(
    `select external_id from platform_connection where account_id = $1 and provider = 'facebook'`,
    [fbAcc.id],
  )).rows[0];
  if (existing) return existing.external_id === page.pageId ? page.pageName : null;
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
              c.sync_in_progress, c.consecutive_failures, c.last_error_type,
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

// Auto-sync org settings: the kill switch + poll interval, both DB-backed so an
// admin can flip them WITHOUT a deploy (this app's deploy pipeline is fragile —
// a runaway must be stoppable in seconds). Readable by anyone (the auto-poller
// needs the interval + enabled flag); only channel-admins can change them.
integrationsRouter.get("/integrations/auto-sync", async (req, res, next) => {
  try {
    const row = (await pool.query(
      "select auto_sync_enabled, auto_sync_interval_minutes from org where id = $1",
      [req.orgId],
    )).rows[0] || {};
    res.json({
      enabled: row.auto_sync_enabled ?? false,
      intervalMinutes: row.auto_sync_interval_minutes ?? 30,
    });
  } catch (err) { next(err); }
});

const AutoSyncSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(5).max(1440).optional(),
});
integrationsRouter.patch("/integrations/auto-sync", requirePermission("channels"), async (req, res, next) => {
  const parsed = AutoSyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "enabled (boolean) and/or intervalMinutes (5-1440) required." });
  const { enabled, intervalMinutes } = parsed.data;
  if (enabled === undefined && intervalMinutes === undefined) return res.status(400).json({ error: "Nothing to update." });
  try {
    const row = (await pool.query(
      `update org set auto_sync_enabled = coalesce($2, auto_sync_enabled),
              auto_sync_interval_minutes = coalesce($3, auto_sync_interval_minutes)
        where id = $1 returning auto_sync_enabled, auto_sync_interval_minutes`,
      [req.orgId, enabled ?? null, intervalMinutes ?? null],
    )).rows[0];
    res.json({ enabled: row.auto_sync_enabled, intervalMinutes: row.auto_sync_interval_minutes });
  } catch (err) { next(err); }
});

// Follower counts for the dashboard: each connection's current count plus its
// value as of the selected range's start (`from`) and end (`to`) — from the
// follower_snapshot timeline — so the card can show the count for the range and
// the growth over it. `from`/`to` are YYYY-MM-DD (omit for "all time").
integrationsRouter.get("/integrations/followers", async (req, res, next) => {
  try {
    const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
    const from = dateOrNull(req.query.from);
    const to = dateOrNull(req.query.to);
    const { rows } = await pool.query(
      `select c.id as "connectionId", c.provider, c.external_id as "externalId", p.key as "platformKey",
              a.workspace_id as "channelId", c.follower_count as current,
              (select follower_count from follower_snapshot s
                where s.connection_id = c.id and s.day <= $2 order by s.day desc limit 1) as "atFrom",
              (select follower_count from follower_snapshot s
                where s.connection_id = c.id and s.day <= $3 order by s.day desc limit 1) as "atTo"
         from platform_connection c
         join account a on a.id = c.account_id
         join platform p on p.id = a.platform_id
        where c.org_id = $1 and c.follower_count is not null`,
      [req.orgId, from, to],
    );
    res.json({ followers: rows });
  } catch (err) {
    next(err);
  }
});

// Day-by-day follower timeline for the dashboard's growth view: one row per
// (connection, day) from follower_snapshot over the last `days` (default 30, max
// 180). The client groups by scope and computes each day's gain/loss vs the
// previous day.
integrationsRouter.get("/integrations/followers/daily", async (req, res, next) => {
  try {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    const { rows } = await pool.query(
      `select s.connection_id as "connectionId", c.provider, c.external_id as "externalId", p.key as "platformKey",
              a.workspace_id as "channelId", to_char(s.day, 'YYYY-MM-DD') as day, s.follower_count as "followerCount"
         from follower_snapshot s
         join platform_connection c on c.id = s.connection_id
         join account a on a.id = c.account_id
         join platform p on p.id = a.platform_id
        where s.org_id = $1 and s.day >= (now() at time zone 'Asia/Kolkata')::date - $2::int
        order by s.day`,
      [req.orgId, days],
    );
    res.json({ series: rows });
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

const SyncSchema = z.object({ accountId: z.string().uuid(), auto: z.boolean().optional() });

// Exponential backoff (minutes) for AUTO-polls after N consecutive transient
// failures: 5, 10, 20, 40, 80, then capped at 120. A flapping connection is
// retried ever less often but never abandoned. Manual clicks ignore this.
function backoffMinutes(failures) {
  return Math.min(2 ** Math.max(0, failures - 1) * 5, 120);
}

// Split sync errors so auto-poll can back off vs. stop. Permanent = auth/token
// problems that won't fix themselves (needs a reconnect); everything else,
// including no-status network/timeout errors, is transient and retryable.
function classifySyncError(err) {
  const status = err?.status;
  const code = err?.code;
  // Meta auth/permission: 190 expired token, 102 session, 10 + 200-299 permission.
  if (status === 401 || status === 403 || code === 190 || code === 102 || code === 10 || (code >= 200 && code <= 299)) {
    return "permanent";
  }
  return "transient"; // 429, 4/17/32/613 rate limits, 5xx, timeouts, unknown
}

// The one guard every platform sync passes through — manual click OR auto-poll,
// from any tab, any user. It (1) takes a per-connection in-flight lock so
// concurrent triggers on the same channel collapse to one real sync, (2) lets
// auto-polls honor the connection's health (skip while backing off, stop on a
// permanent/needs-reconnect error), and (3) records success/failure health.
// `work` does the provider-specific fetch + writes and returns { statusText }.
// `classify` maps a thrown error to 'transient' | 'permanent' (default is the
// Meta rule; YouTube overrides it since it has no per-connection token to expire).
async function runConnectionSync(conn, { auto = false, classify = classifySyncError }, work) {
  // Atomic lock acquire; a lock older than 15 min is treated as stale (left by a
  // crashed sync) and re-acquired so a connection can never wedge permanently.
  // `returning sync_started_at` gives us a token identifying OUR hold, so the
  // finally below only releases the lock if it's still ours (a stale-recovery
  // re-acquire by someone else must not be cleared out from under them).
  const lockToken = (await pool.query(
    `update platform_connection
        set sync_in_progress = true, sync_started_at = now(), sync_lock_token = gen_random_uuid()
      where id = $1 and (sync_in_progress = false or sync_started_at < now() - interval '15 minutes')
      returning sync_lock_token`,
    [conn.id],
  )).rows[0]?.sync_lock_token;
  if (!lockToken) return { skipped: "in_progress" };

  try {
    if (auto) {
      const h = (await pool.query(
        `select c.last_error_type, c.consecutive_failures, c.last_attempt_at, c.last_synced_at,
                o.auto_sync_interval_minutes as interval_min
           from platform_connection c join org o on o.id = c.org_id where c.id = $1`,
        [conn.id],
      )).rows[0] || {};
      if (h.last_error_type === "permanent") return { skipped: "needs_reconnect" };
      if (h.consecutive_failures > 0 && h.last_attempt_at &&
          Date.now() - new Date(h.last_attempt_at).getTime() < backoffMinutes(h.consecutive_failures) * 60_000) {
        return { skipped: "backoff" };
      }
      // Freshness short-circuit: if this connection was successfully synced within
      // ~80% of the poll interval, skip the real work. This caps actual syncs to
      // roughly once per interval per connection GLOBALLY — so N admin tabs (or
      // page navigations / refocuses) collapse to one real sync, not N.
      const freshMs = (h.interval_min ?? 30) * 60_000 * 0.8;
      if (h.last_synced_at && Date.now() - new Date(h.last_synced_at).getTime() < freshMs) {
        return { skipped: "fresh" };
      }
    }
    const result = await work();
    // Proactive throttle: if Meta reports app-usage near its cap (X-App-Usage),
    // hold the connection off auto-polling for one backoff step (~5 min) even on
    // success — rather than waiting for a hard 429. Kept distinct from a real
    // failure (last_error_type stays null, so the UI shows healthy, not retrying).
    const cooldown = result.usage != null && result.usage >= 90 ? 1 : 0;
    // last_synced_at = last SUCCESS (drives the "Live · Xh ago" status);
    // last_attempt_at = this attempt (drives backoff).
    await pool.query(
      `update platform_connection set last_synced_at = now(), last_attempt_at = now(),
              last_sync_status = $2, consecutive_failures = $3, last_error_type = null where id = $1`,
      [conn.id, result.statusText, cooldown],
    );
    return { ran: true, result };
  } catch (err) {
    const errorType = classify(err);
    // On failure, bump last_attempt_at but NOT last_synced_at — the status keeps
    // showing the true last-good time, and health reflects the failure instead.
    await pool.query(
      `update platform_connection set last_attempt_at = now(), last_sync_status = $2, last_error_type = $3,
              consecutive_failures = case when $3 = 'transient' then consecutive_failures + 1 else consecutive_failures end
        where id = $1`,
      [conn.id, `Failed: ${String(err.message).slice(0, 120)}`, errorType],
    );
    return { error: err, errorType };
  } finally {
    // Release only if we still hold the lock — a stale-recovery re-acquire by
    // another sync gets a new token, so we won't clear it out from under it.
    await pool.query(
      "update platform_connection set sync_in_progress = false where id = $1 and sync_lock_token = $2",
      [conn.id, lockToken],
    ).catch(() => {});
  }
}

// ===== Facebook (Meta Page) — its own connection, shares the Meta OAuth =====

// Facebook connect accepts an optional explicit pageId: when several Pages are
// visible to the token, the UI lets the user pick exactly which Page attaches to
// this channel (the fix for a channel showing the wrong Page's data). Without it
// we fall back to matching the channel handle, else the only Page.
const FbConnectSchema = z.object({ accountId: z.string().uuid(), pageId: z.string().min(1).optional() });
const FbConnectTokenSchema = z.object({ accountId: z.string().uuid(), token: z.string().min(20), pageId: z.string().min(1).optional() });
const FbPagesSchema = z.object({ accountId: z.string().uuid(), token: z.string().min(20).optional() });

// Resolve which Page to connect. An explicit pageId (from the picker) wins; else
// match the channel handle to a Page name; else the sole Page. Returns null when
// the choice is ambiguous (several Pages, no explicit pick) so the caller can ask.
function resolveChosenPage(pages, handle, pageId) {
  if (pageId) return pages.find((p) => String(p.pageId) === String(pageId)) || null;
  const h = (handle || "").replace(/^@/, "").toLowerCase();
  return pages.find((p) => p.pageName?.toLowerCase() === h) || (pages.length === 1 ? pages[0] : null);
}

// List the Facebook Pages a token can see — WITHOUT connecting — so the UI can
// show a picker. Uses the pasted token when given, else the server system token.
integrationsRouter.post("/integrations/facebook/pages", requirePermission("channels"), async (req, res, next) => {
  const parsed = FbPagesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "accountId is required" });
  const token = parsed.data.token || (ig.systemTokenConfigured() ? ig.systemToken() : null);
  if (!token) return res.status(400).json({ error: "No token available — paste a token or set META_SYSTEM_TOKEN on the server." });
  try {
    const acct = (await pool.query(
      `select a.id from account a join platform p on p.id = a.platform_id
        where a.id = $1 and a.org_id = $2 and p.key = 'facebook'`,
      [parsed.data.accountId, req.orgId],
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Unknown Facebook account" });
    let pages;
    try { pages = await fb.listPages(token); }
    catch (err) { return res.status(502).json({ error: `Meta token error: ${err.message}` }); }
    res.json({ pages: pages.map((p) => ({ pageId: p.pageId, pageName: p.pageName, followers: p.followers })) });
  } catch (err) { next(err); }
});

// One-click Facebook connect via the server system token. Picks the Page (an
// explicit pageId from the picker, else the channel's handle, else the only one).
integrationsRouter.post("/integrations/facebook/connect-system", requirePermission("channels"), async (req, res, next) => {
  const parsed = FbConnectSchema.safeParse(req.body);
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

    const chosen = resolveChosenPage(pages, acct.handle, parsed.data.pageId);
    if (!chosen) {
      return res.status(409).json({
        error: `The token sees ${pages.length} Pages. Choose which one to connect.`,
        needsPageChoice: true,
        pages: pages.map((p) => ({ pageId: p.pageId, pageName: p.pageName, followers: p.followers })),
      });
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
  const parsed = FbConnectTokenSchema.safeParse(req.body);
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

    const chosen = resolveChosenPage(pages, acct.handle, parsed.data.pageId);
    if (!chosen) {
      return res.status(409).json({
        error: `This token sees ${pages.length} Pages. Choose which one to connect.`,
        needsPageChoice: true,
        pages: pages.map((p) => ({ pageId: p.pageId, pageName: p.pageName, followers: p.followers })),
      });
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

    // Config gate only (no API call): a SYSTEM connection needs the env token set.
    if (conn.access_token_enc === "SYSTEM" && !ig.systemTokenConfigured()) {
      return res.status(400).json({ error: "This connection uses the system token, but META_SYSTEM_TOKEN isn't set." });
    }

    let counts = { total: 0, matched: 0, updated: 0 };
    const outcome = await runConnectionSync(conn, { auto: parsed.data.auto === true }, async () => {
      // Resolve the Page token INSIDE the guard so the SYSTEM-token listPages call
      // is lock-protected and its failures get classified / backed off (rather
      // than running unguarded on every poll and 500-ing past the backoff logic).
      let pageToken;
      if (conn.access_token_enc === "SYSTEM") {
        const page = (await fb.listPages(ig.systemToken())).find((p) => p.pageId === conn.external_id);
        if (!page) { const e = new Error("The system token can no longer see this Page."); e.code = 190; throw e; }
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

      const map = await fb.listPostsByPermalink(conn.external_id, pageToken);

      // Match posts to fetched Page posts, then pull all their engagement counts
      // in batched Graph calls (<=50 posts per HTTP request) instead of one each.
      const pairs = [];
      for (const post of posts) {
        const m = map.get(fb.normalizePermalink(post.permalink));
        if (m) pairs.push({ postId: post.id, externalId: m.id });
      }
      const { metrics, usage } = await fb.getPostMetricsBatch(pairs.map((p) => p.externalId), pageToken);

      // One bulk UPDATE for all matched posts (fewer pooled-connection round trips).
      if (pairs.length) {
        const ids = [], likes = [], comments = [], shares = [], extIds = [];
        for (const { postId, externalId } of pairs) {
          const met = metrics.get(externalId) || {};
          ids.push(postId); likes.push(met.likes ?? 0); comments.push(met.comments ?? 0);
          shares.push(met.shares ?? 0); extIds.push(externalId);
        }
        await pool.query(
          `update post p set likes=d.likes, comments=d.comments, shares=d.shares,
                  external_id=d.external_id, last_synced_at=now(), metrics_updated_at=now()
             from (select unnest($1::uuid[]) as id, unnest($2::bigint[]) as likes,
                          unnest($3::bigint[]) as comments, unnest($4::bigint[]) as shares,
                          unnest($5::text[]) as external_id) d
            where p.id = d.id`,
          [ids, likes, comments, shares, extIds],
        );
      }

      const followers = await fb.getPageFollowers(conn.external_id, pageToken);
      if (followers != null) {
        await pool.query("update platform_connection set follower_count = $2 where id = $1", [conn.id, followers]);
      }
      captureFollowerSnapshots(conn.id).catch(() => {}); // record today's count into the timeline

      counts = { total: posts.length, matched: pairs.length, updated: pairs.length };
      return { statusText: `Synced ${counts.updated}/${counts.total} post${counts.total === 1 ? "" : "s"}`, usage };
    });

    if (outcome.skipped) return res.json({ ok: true, skipped: outcome.skipped });
    if (outcome.error) {
      return res.status(outcome.errorType === "permanent" ? 400 : 502)
        .json({ error: `Facebook API error: ${outcome.error.message}`, errorType: outcome.errorType });
    }
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "published",
      entityType: "channel", entityId: conn.workspace_id, channelId: conn.workspace_id,
      summary: `Synced ${counts.updated} post${counts.updated === 1 ? "" : "s"} from Facebook`,
    });
    res.json({ ok: true, ...counts, unmatched: counts.total - counts.matched });
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

    let counts = { total: 0, matched: 0, updated: 0 };
    const outcome = await runConnectionSync(conn, { auto: parsed.data.auto === true }, async () => {
      // Every post on this channel × platform that has a Link to match against.
      // Collab mirrors are skipped here — the collab media lives on the OWNER's
      // account, so it wouldn't match; its metrics are copied from the owner below.
      const posts = (await pool.query(
        `select id, permalink, collab_group_id from post
          where workspace_id = $1 and platform_id = $2 and deleted_at is null
            and permalink is not null and is_collab_mirror = false`,
        [conn.workspace_id, conn.platform_id],
      )).rows;

      const mediaMap = await ig.listMediaByPermalink(conn.external_id, token);

      // Match posts to fetched media, then pull all their insights in batched
      // Graph calls (<=50 media per HTTP request) instead of one call per post.
      const pairs = [];
      for (const post of posts) {
        const media = mediaMap.get(ig.normalizePermalink(post.permalink));
        if (media) pairs.push({ post, media });
      }
      const { metrics, usage } = await ig.getMediaMetricsBatch(pairs.map((p) => p.media), token);

      // Write all matched posts in ONE statement — far fewer pooled-connection
      // round trips than an UPDATE per post (the pooler cap is the constraint).
      if (pairs.length) {
        const ids = [], views = [], reach = [], likes = [], comments = [], shares = [], saves = [], extIds = [];
        for (const { post, media } of pairs) {
          const m = metrics.get(media.id) || {};
          ids.push(post.id); views.push(m.views ?? 0); reach.push(m.reach ?? 0);
          likes.push(m.likes ?? 0); comments.push(m.comments ?? 0); shares.push(m.shares ?? 0);
          saves.push(m.saves ?? 0); extIds.push(media.id);
        }
        await pool.query(
          `update post p set views=d.views, reach=d.reach, likes=d.likes, comments=d.comments,
                  shares=d.shares, saves=d.saves, external_id=d.external_id,
                  last_synced_at=now(), metrics_updated_at=now()
             from (select unnest($1::uuid[]) as id, unnest($2::bigint[]) as views,
                          unnest($3::bigint[]) as reach, unnest($4::bigint[]) as likes,
                          unnest($5::bigint[]) as comments, unnest($6::bigint[]) as shares,
                          unnest($7::bigint[]) as saves, unnest($8::text[]) as external_id) d
            where p.id = d.id`,
          [ids, views, reach, likes, comments, shares, saves, extIds],
        );
        // Collab mirrors live on the collaborating channel's account — copy each
        // collab post's numbers onto its mirror row(s) (uncommon, so left per-post).
        for (const { post, media } of pairs) {
          if (!post.collab_group_id) continue;
          const m = metrics.get(media.id) || {};
          await pool.query(
            `update post set views=$2, reach=$3, likes=$4, comments=$5, shares=$6, saves=$7,
                    last_synced_at=now(), metrics_updated_at=now()
              where collab_group_id=$1 and is_collab_mirror = true and deleted_at is null`,
            [post.collab_group_id, m.views ?? 0, m.reach ?? 0, m.likes ?? 0, m.comments ?? 0, m.shares ?? 0, m.saves ?? 0],
          );
        }
      }

      // Refresh the account's follower count (node field, not an insight).
      const followers = await ig.getIgFollowers(conn.external_id, token);
      if (followers != null) {
        await pool.query("update platform_connection set follower_count = $2 where id = $1", [conn.id, followers]);
      }
      captureFollowerSnapshots(conn.id).catch(() => {}); // record today's count into the timeline

      counts = { total: posts.length, matched: pairs.length, updated: pairs.length };
      return { statusText: `Synced ${counts.updated}/${counts.total} post${counts.total === 1 ? "" : "s"}`, usage };
    });

    if (outcome.skipped) return res.json({ ok: true, skipped: outcome.skipped });
    if (outcome.error) {
      return res.status(outcome.errorType === "permanent" ? 400 : 502)
        .json({ error: `Instagram API error: ${outcome.error.message}`, errorType: outcome.errorType });
    }
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "published",
      entityType: "channel", entityId: conn.workspace_id, channelId: conn.workspace_id,
      summary: `Synced ${counts.updated} post${counts.updated === 1 ? "" : "s"} from Instagram`,
    });
    res.json({ ok: true, ...counts, unmatched: counts.total - counts.matched });
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

    let counts = { total: 0, matched: 0, updated: 0 };
    // YouTube errors are always transient for backoff purposes: there's no
    // per-connection token to expire, so "needs reconnect" doesn't apply — a bad
    // key or exhausted daily quota is an org-level, self-resolving condition.
    const outcome = await runConnectionSync(conn, { auto: parsed.data.auto === true, classify: () => "transient" }, async () => {
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
      const stats = await yt.fetchVideoStats([...idToPosts.keys()], ytKey); // already batched

      // Bulk-update all matched posts in one statement. Tier 1 exposes
      // views/likes/comments only — leave reach/shares/saves untouched.
      const ids = [], views = [], likes = [], comments = [];
      let matched = 0;
      for (const [vid, postIds] of idToPosts) {
        const s = stats.get(vid);
        if (!s) continue;
        for (const pid of postIds) {
          ids.push(pid); views.push(s.views); likes.push(s.likes); comments.push(s.comments);
          matched += 1;
        }
      }
      if (ids.length) {
        await pool.query(
          `update post p set views=d.views, likes=d.likes, comments=d.comments,
                  last_synced_at=now(), metrics_updated_at=now()
             from (select unnest($1::uuid[]) as id, unnest($2::bigint[]) as views,
                          unnest($3::bigint[]) as likes, unnest($4::bigint[]) as comments) d
            where p.id = d.id`,
          [ids, views, likes, comments],
        );
      }

      // Refresh subscriber count (best-effort — works even if no videos matched).
      let subscribers = null;
      try {
        const ch = await yt.fetchChannelStats([conn.external_id], ytKey);
        subscribers = ch.get(conn.external_id)?.subscribers ?? null;
      } catch { /* subscriber count is optional */ }
      if (subscribers != null) {
        await pool.query("update platform_connection set follower_count = $2 where id = $1", [conn.id, subscribers]);
      }

      counts = { total: posts.length, matched, updated: matched };
      return { statusText: `Synced ${matched}/${posts.length} video${posts.length === 1 ? "" : "s"}` };
    });

    if (outcome.skipped) return res.json({ ok: true, skipped: outcome.skipped });
    if (outcome.error) return res.status(502).json({ error: `YouTube API error: ${outcome.error.message}`, errorType: outcome.errorType });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "published",
      entityType: "channel", entityId: conn.workspace_id, channelId: conn.workspace_id,
      summary: `Synced ${counts.updated} video${counts.updated === 1 ? "" : "s"} from YouTube`,
    });
    res.json({ ok: true, ...counts, unmatched: counts.total - counts.matched });
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
