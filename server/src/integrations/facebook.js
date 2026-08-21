import { config } from "../config.js";

// Facebook Page client (Meta Graph API). Shares the Meta app + OAuth with the
// Instagram integration (see instagram.js) — same META_* config, same token —
// but pulls Page-level data. Uses a current API version; the older Instagram
// helper still targets v21.0.
// Docs: https://developers.facebook.com/docs/graph-api/reference/page
const API = "https://graph.facebook.com/v23.0";

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

// Every Facebook Page this user/token manages (NOT filtered to IG-linked ones —
// that's the difference from instagram.listIgAccounts). Includes a long-lived
// Page token and the current follower count.
export async function listPages(userToken) {
  const json = await graphGet("me/accounts", {
    fields: "id,name,access_token,followers_count",
    access_token: userToken,
    limit: "100",
  });
  return (json.data ?? []).map((p) => ({
    pageId: p.id,
    pageName: p.name,
    pageToken: p.access_token,
    followers: p.followers_count ?? null,
  }));
}

// Current follower count for a Page (page node field, not an insights metric —
// unaffected by the Nov-2025 / Jun-2026 Insights deprecations).
export async function getPageFollowers(pageId, token) {
  try {
    const json = await graphGet(pageId, { fields: "followers_count", access_token: token });
    return json.followers_count ?? null;
  } catch {
    return null;
  }
}

// This Page's published posts keyed by a normalized permalink, so a pasted Link
// can be matched to a real post id (same approach as the Instagram sync).
export async function listPostsByPermalink(pageId, token) {
  const map = new Map();
  let after = null;
  let guard = 0;
  do {
    const params = { fields: "id,permalink_url,created_time", access_token: token, limit: "100" };
    if (after) params.after = after;
    const json = await graphGet(`${pageId}/posts`, params);
    for (const p of json.data ?? []) {
      if (p.permalink_url) map.set(normalizePermalink(p.permalink_url), p);
    }
    after = json.paging?.cursors?.after && json.paging?.next ? json.paging.cursors.after : null;
    guard += 1;
  } while (after && guard < 20);
  return map;
}

// Engagement counts for a post via node EDGES (reactions/comments summaries +
// shares), NOT Insights metrics — so they survived the impressions/reach
// deprecations. All reaction types collapse into one total (per product decision).
// Views/reach are intentionally NOT fetched (Option 2): the impression metrics
// are deprecated and the media-view replacements aren't comparable to Instagram.
export async function getPostMetrics(postId, token) {
  const json = await graphGet(postId, {
    fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares",
    access_token: token,
  });
  return {
    likes: json.reactions?.summary?.total_count ?? 0,
    comments: json.comments?.summary?.total_count ?? 0,
    shares: json.shares?.count ?? 0,
  };
}

// Facebook post permalinks take several forms (/{page}/posts/{id},
// /permalink.php?story_fbid=…&id=…, /{pageid}_{postid}). Match on the longest
// numeric id in the URL — the stable post identifier across those forms.
export function normalizePermalink(url) {
  if (!url) return "";
  const ids = String(url).match(/\d{6,}/g);
  if (ids && ids.length) return ids.sort((a, b) => b.length - a.length)[0];
  return String(url).trim().replace(/[?#].*$/, "").toLowerCase();
}
