import { config } from "../config.js";

// Thin YouTube Data API v3 client (Tier 1 — public stats via an org-wide API
// key, no OAuth). Uses global fetch (Node 18+).
// Docs: https://developers.google.com/youtube/v3/docs/videos/list
const API = "https://www.googleapis.com/youtube/v3";

export function apiKeyConfigured() {
  return Boolean(config.YOUTUBE_API_KEY);
}
export function apiKey() {
  return config.YOUTUBE_API_KEY;
}

// Pull the 11-char video id out of any common YouTube URL form (watch, youtu.be,
// Shorts, embed, live). Returns null if the link isn't a recognisable video URL.
export function extractVideoId(url) {
  if (!url) return null;
  const s = String(url);
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,        // watch?v=ID
    /youtu\.be\/([A-Za-z0-9_-]{11})/,   // youtu.be/ID
    /\/shorts\/([A-Za-z0-9_-]{11})/,    // /shorts/ID
    /\/embed\/([A-Za-z0-9_-]{11})/,     // /embed/ID
    /\/live\/([A-Za-z0-9_-]{11})/,      // /live/ID
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

async function ytGet(path, params, key) {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key }).toString()}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message || `YouTube API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Confirm an API key actually works before storing it — a cheap probe (1 unit)
// that needs a valid, YouTube-Data-API-enabled key. Throws with a readable
// message on an invalid/unauthorized/not-enabled key.
export async function validateKey(key) {
  if (!key || key.trim().length < 10) { const e = new Error("Enter a YouTube API key."); e.status = 400; throw e; }
  try {
    await ytGet("i18nLanguages", { part: "snippet", hl: "en" }, key.trim());
    return true;
  } catch (err) {
    const e = new Error(`That YouTube API key didn't work: ${err.message}`);
    e.status = 400;
    throw e;
  }
}

// Statistics for a list of video ids, batched 50 per call (1 quota unit each).
// Returns Map(videoId -> { views, likes, comments, channelId, channelTitle }).
// likeCount is absent when the uploader hides it and commentCount is absent when
// comments are disabled — both coerce to 0.
export async function fetchVideoStats(ids, key) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await ytGet("videos", { part: "statistics,snippet", id: chunk.join(",") }, key);
    for (const v of json.items ?? []) {
      const s = v.statistics ?? {};
      out.set(v.id, {
        views: Number(s.viewCount ?? 0),
        likes: Number(s.likeCount ?? 0),
        comments: Number(s.commentCount ?? 0),
        channelId: v.snippet?.channelId ?? null,
        channelTitle: v.snippet?.channelTitle ?? null,
      });
    }
  }
  return out;
}

// Resolve a user-entered channel URL or handle to a real YouTube channel via
// channels.list (org API key — no OAuth). Accepts:
//   https://youtube.com/@handle · @handle · youtube.com/channel/UC… · a bare UC… id
//   · youtube.com/user/legacyName. Returns { channelId, title, subscribers } or
// throws — an unresolvable handle must fail visibly, never "connect" to nothing.
export async function resolveChannel(input, key) {
  const s = String(input || "").trim();
  if (!s) { const e = new Error("Enter a YouTube channel URL or @handle."); e.status = 400; throw e; }

  let params = null;
  let m;
  if ((m = s.match(/channel\/(UC[A-Za-z0-9_-]{20,})/)) || (m = s.match(/^(UC[A-Za-z0-9_-]{20,})$/))) {
    params = { part: "snippet,statistics", id: m[1] };
  } else if ((m = s.match(/@([A-Za-z0-9._-]+)/))) {
    params = { part: "snippet,statistics", forHandle: "@" + m[1] };
  } else if ((m = s.match(/\/user\/([A-Za-z0-9._-]+)/))) {
    params = { part: "snippet,statistics", forUsername: m[1] };
  } else {
    const e = new Error(`Couldn't read a channel from “${s}”. Paste the channel URL or its @handle.`);
    e.status = 400;
    throw e;
  }

  const json = await ytGet("channels", params, key);
  const c = json.items?.[0];
  if (!c) {
    const e = new Error(`No YouTube channel found for “${s}”. Check the URL/handle and try again.`);
    e.status = 404;
    throw e;
  }
  return {
    channelId: c.id,
    title: c.snippet?.title ?? null,
    subscribers: c.statistics?.subscriberCount != null ? Number(c.statistics.subscriberCount) : null,
  };
}

// Subscriber count + title for channel ids, batched 50 per call. Returns
// Map(channelId -> { subscribers, title }). subscriberCount is hidden by some
// channels (absent) -> 0.
export async function fetchChannelStats(channelIds, key) {
  const out = new Map();
  const ids = [...new Set(channelIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await ytGet("channels", { part: "statistics,snippet", id: chunk.join(",") }, key);
    for (const c of json.items ?? []) {
      out.set(c.id, {
        subscribers: Number(c.statistics?.subscriberCount ?? 0),
        title: c.snippet?.title ?? null,
      });
    }
  }
  return out;
}
