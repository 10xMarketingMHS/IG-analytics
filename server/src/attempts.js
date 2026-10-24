// Tries counted per address and per address + email, in memory, over a fixed
// window — so a password can't be guessed without limit, nor the forgot-
// password request flooded. Kept per server process (a restart starts again),
// which is enough to make guessing slow. Used by auth.js.
export function attemptLimiter({ windowMs, perEmail, perAddress }) {
  const hits = new Map(); // key -> { n, start }
  const live = (key, now) => {
    const h = hits.get(key);
    if (!h || now - h.start >= windowMs) return null;
    return h;
  };
  function tidy(now) {
    if (hits.size < 5000) return;
    for (const [k, h] of hits) if (now - h.start >= windowMs) hits.delete(k);
    if (hits.size >= 20000) hits.clear(); // a flood of made-up addresses: start over
  }
  const keys = (ip, email) => [[`a|${ip}`, perAddress], [`e|${ip}|${String(email).toLowerCase()}`, perEmail]];
  return {
    // minutes until another try is allowed, or 0
    wait(ip, email) {
      const now = Date.now();
      let ms = 0;
      for (const [k, max] of keys(ip, email)) {
        const h = live(k, now);
        if (h && h.n >= max) ms = Math.max(ms, h.start + windowMs - now);
      }
      return ms ? Math.max(1, Math.ceil(ms / 60_000)) : 0;
    },
    count(ip, email) {
      const now = Date.now();
      tidy(now);
      for (const [k] of keys(ip, email)) {
        const h = live(k, now);
        if (h) h.n++;
        else hits.set(k, { n: 1, start: now });
      }
    },
    // a right password: that email's count from this address starts again
    clear(ip, email) {
      hits.delete(keys(ip, email)[1][0]);
    },
  };
}
