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

async function ytGet(path, params) {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key: apiKey() }).toString()}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message || `YouTube API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Statistics for a list of video ids, batched 50 per call (1 quota unit each).
// Returns Map(videoId -> { views, likes, comments, channelId, channelTitle }).
// likeCount is absent when the uploader hides it and commentCount is absent when
// comments are disabled — both coerce to 0.
export async function fetchVideoStats(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await ytGet("videos", { part: "statistics,snippet", id: chunk.join(",") });
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

// Subscriber count + title for channel ids, batched 50 per call. Returns
// Map(channelId -> { subscribers, title }). subscriberCount is hidden by some
// channels (absent) -> 0.
export async function fetchChannelStats(channelIds) {
  const out = new Map();
  const ids = [...new Set(channelIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await ytGet("channels", { part: "statistics,snippet", id: chunk.join(",") });
    for (const c of json.items ?? []) {
      out.set(c.id, {
        subscribers: Number(c.statistics?.subscriberCount ?? 0),
        title: c.snippet?.title ?? null,
      });
    }
  }
  return out;
}
