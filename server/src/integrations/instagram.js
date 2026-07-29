import { config } from "../config.js";

// Thin Instagram Graph API client (Meta). Uses global fetch (Node 18+).
// Docs: https://developers.facebook.com/docs/instagram-api
const API = "https://graph.facebook.com/v21.0";

export function metaConfigured() {
  return Boolean(config.META_APP_ID && config.META_APP_SECRET && config.APP_BASE_URL);
}

// A long-lived System User token — the one-click, never-expires path.
export function systemTokenConfigured() {
  return Boolean(config.META_SYSTEM_TOKEN);
}
export function systemToken() {
  return config.META_SYSTEM_TOKEN;
}

export function redirectUri() {
  return `${config.APP_BASE_URL}/api/integrations/instagram/callback`;
}

// The permission scopes we need to read Instagram insights via a linked Page.
export const SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: config.META_APP_ID,
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${p.toString()}`;
}

async function graphGet(path, params) {
  const url = `${API}/${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message || `Graph API error (${res.status})`);
    err.code = json.error?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

// OAuth code → short-lived user token → long-lived (~60 day) user token.
export async function exchangeCode(code) {
  const short = await graphGet("oauth/access_token", {
    client_id: config.META_APP_ID,
    client_secret: config.META_APP_SECRET,
    redirect_uri: redirectUri(),
    code,
  });
  const long = await graphGet("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: config.META_APP_ID,
    client_secret: config.META_APP_SECRET,
    fb_exchange_token: short.access_token,
  });
  return { token: long.access_token, expiresIn: long.expires_in ?? null };
}

// The Pages this user manages, each with its linked IG business account.
export async function listIgAccounts(userToken) {
  const json = await graphGet("me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: userToken,
    limit: "100",
  });
  const out = [];
  for (const page of json.data ?? []) {
    if (page.instagram_business_account) {
      out.push({
        pageId: page.id,
        pageName: page.name,
        pageToken: page.access_token, // long-lived page token (inherits from long user token)
        igId: page.instagram_business_account.id,
        igUsername: page.instagram_business_account.username,
      });
    }
  }
  return out;
}

// All media for an IG account (paginated), newest first, keyed by permalink.
export async function listMediaByPermalink(igId, token) {
  const map = new Map(); // normalized permalink -> media summary
  let after = null;
  let guard = 0;
  do {
    const params = {
      fields: "id,permalink,media_type,media_product_type,like_count,comments_count,timestamp",
      access_token: token,
      limit: "100",
    };
    if (after) params.after = after;
    const json = await graphGet(`${igId}/media`, params);
    for (const m of json.data ?? []) {
      if (m.permalink) map.set(normalizePermalink(m.permalink), m);
    }
    after = json.paging?.cursors?.after && json.paging?.next ? json.paging.cursors.after : null;
    guard += 1;
  } while (after && guard < 20); // cap at ~2000 media
  return map;
}

// Insights degrade gracefully across API versions / media types: try the
// richest metric set, fall back to smaller sets until one succeeds.
const INSIGHT_ATTEMPTS = [
  ["reach", "saved", "shares", "views"],
  ["reach", "saved", "shares", "impressions"],
  ["reach", "saved", "shares"],
  ["reach"],
];

export async function getMediaMetrics(media, token) {
  const out = { views: 0, reach: 0, likes: media.like_count ?? 0, comments: media.comments_count ?? 0, shares: 0, saves: 0 };
  for (const metrics of INSIGHT_ATTEMPTS) {
    try {
      const json = await graphGet(`${media.id}/insights`, { metric: metrics.join(","), access_token: token });
      const v = {};
      for (const d of json.data ?? []) v[d.name] = d.values?.[0]?.value ?? 0;
      out.reach = v.reach ?? out.reach;
      out.saves = v.saved ?? out.saves;
      out.shares = v.shares ?? out.shares;
      out.views = v.views ?? v.impressions ?? out.views;
      return out;
    } catch {
      // try the next, smaller metric set
    }
  }
  return out; // insights unavailable — likes/comments from the media node still returned
}

// Instagram permalinks come as /p/<code>/ or /reel/<code>/. Normalize to the
// shortcode so a pasted Link matches regardless of trailing slashes / query.
export function normalizePermalink(url) {
  if (!url) return "";
  const m = String(url).match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : String(url).trim().replace(/[/?#].*$/, "").toLowerCase();
}
