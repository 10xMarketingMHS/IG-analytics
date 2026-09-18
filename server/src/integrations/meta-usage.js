// Meta Graph API rate-limit signal. Every response carries an `X-App-Usage`
// header — a JSON string with call_count / total_cputime / total_time as
// percentages (0-100) of the app's sliding-window budget; Meta throttles once
// any reaches 100. Business-scoped calls also return `X-Business-Use-Case-Usage`
// (per-business array, incl. estimated_time_to_regain_access minutes). We read
// these so the sync scheduler can throttle PROACTIVELY when usage is high rather
// than only after a hard 429 (see the auto-sync backoff logic).
// Header format verified against
// https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ (Sep 2026).

// Highest of the three app-usage percentages, or null if the header is absent /
// unparseable (best-effort — a missing signal must never break a sync).
export function parseAppUsage(headerValue) {
  if (!headerValue) return null;
  try {
    const u = JSON.parse(headerValue);
    const pct = Math.max(
      Number(u.call_count) || 0,
      Number(u.total_cputime) || 0,
      Number(u.total_time) || 0,
    );
    return Number.isFinite(pct) ? pct : null;
  } catch {
    return null;
  }
}

// Longest "time to regain access" (minutes) across the businesses in an
// X-Business-Use-Case-Usage header, or null. Used to set a concrete backoff
// window when Meta tells us exactly how long to wait.
export function parseBucRegainMinutes(headerValue) {
  if (!headerValue) return null;
  try {
    const obj = JSON.parse(headerValue);
    let max = 0;
    for (const arr of Object.values(obj)) {
      for (const e of arr ?? []) {
        const m = Number(e?.estimated_time_to_regain_access) || 0;
        if (m > max) max = m;
      }
    }
    return max > 0 ? max : null;
  } catch {
    return null;
  }
}
