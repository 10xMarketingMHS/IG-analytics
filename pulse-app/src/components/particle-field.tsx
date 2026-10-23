import { useEffect, useRef } from "react";

// A field of small dashes on rings around one point, each pointing at the
// middle, turning slowly — the inner rings faster — and stepping aside around
// the pointer. Colour comes
// from where a dash is on screen (blue at the top, through violet and pink,
// to orange low on the left), shifted toward the person's accent. Used behind
// the sign-in panel (login.tsx); drawn on a canvas, still for reduced motion.

type Dash = { r: number; a: number; len: number; sp: number; tw: number; tilt: number; ox: number; oy: number };

const HUES = 48;      // colours are batched: one path per hue and alpha step
const ALPHAS = 4;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// screen angle (0 = top, going clockwise, 0…1) → hue
const STOPS: [number, number][] = [[0, 255], [0.25, 272], [0.5, 300], [0.62, 335], [0.74, 25], [0.86, 290], [1, 255]];
function hueAt(t: number) {
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, h1] = STOPS[i - 1], [t2, h2] = STOPS[i];
    if (t <= t2) {
      let d = h2 - h1;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      return h1 + (d * (t - t1)) / (t2 - t1);
    }
  }
  return STOPS[0][1];
}

export function ParticleField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0, H = 0, dpr = 1;
    let dashes: Dash[] = [];
    let rMin = 0, rMax = 0, cx0 = 0, cy0 = 0, cx = 0, cy = 0;
    // the pointer over the panel (null when it isn't)
    let pointer: { x: number; y: number } | null = null;

    const build = () => {
      dashes = [];
      cx0 = cx = W * 0.56; cy0 = cy = H * 0.4;
      rMin = Math.max(60, Math.min(W, H) * 0.2);         // an open middle
      rMax = Math.hypot(Math.max(cx0, W - cx0), Math.max(cy0, H - cy0)) * 1.02;
      const gap = Math.max(11, Math.min(W, H) / 34);       // between rings
      const step = gap * 1.35;                              // between dashes on a ring
      const area = W * H, cap = Math.min(1500, Math.max(320, area / 260));
      let slots = 0;
      for (let r = rMin; r < rMax; r += gap) slots += Math.floor((2 * Math.PI * r) / step);
      const keep = Math.min(0.62, cap / Math.max(1, slots));
      for (let r = rMin; r < rMax; r += gap) {
        const n = Math.floor((2 * Math.PI * r) / step);
        for (let i = 0; i < n; i++) {
          if (Math.random() > keep) continue;
          dashes.push({
            r: r + (Math.random() - 0.5) * gap * 0.5,
            a: (i / n) * Math.PI * 2 + Math.random() * 0.2,
            len: 3 + Math.random() * 4.5,
            sp: 0.8 + Math.random() * 0.4,
            tw: Math.random() * Math.PI * 2,
            tilt: (Math.random() - 0.5) * 0.6,
            ox: 0, oy: 0,
          });
        }
      }
    };

    const fit = () => {
      const rect = cv.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = rect.width; H = rect.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      if (still) draw(0);
    };

    // the colours for this theme and accent
    let colours: string[] = [];
    let key = "";
    const palette = () => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const ac = Number(getComputedStyle(document.documentElement).getPropertyValue("--acH")) || 290;
      const k = `${dark}|${ac}`;
      if (k === key) return;
      key = k;
      const shift = (ac - 290) * 0.45, L = dark ? 0.74 : 0.6, C = dark ? 0.17 : 0.21;
      colours = [];
      for (let h = 0; h < HUES; h++) {
        const hue = (hueAt(h / HUES) + shift + 360) % 360;
        for (let s = 0; s < ALPHAS; s++) colours.push(`oklch(${L} ${C} ${hue.toFixed(1)} / ${((s + 1) / ALPHAS) * (dark ? 0.95 : 0.9)})`);
      }
    };

    const paths: number[][] = Array.from({ length: HUES * ALPHAS }, () => []);
    let t = 0;
    const draw = (dt: number) => {
      palette();
      t += dt;
      ctx.clearRect(0, 0, W, H);
      for (const p of paths) p.length = 0;
      // the centre leans a little toward the pointer
      const tx = pointer ? cx0 + (pointer.x - cx0) * 0.06 : cx0, ty = pointer ? cy0 + (pointer.y - cy0) * 0.06 : cy0;
      cx += (tx - cx) * 0.05; cy += (ty - cy) * 0.05;
      const R = Math.max(90, Math.min(W, H) * 0.2), R2 = R * R;
      for (const d of dashes) {
        if (!still) d.a += (0.05 + 5 / d.r) * d.sp * dt;
        const rr = d.r * (1 + (still ? 0 : 0.014 * Math.sin(t * 0.6 + d.r * 0.012)));
        let x = cx + Math.cos(d.a) * rr, y = cy + Math.sin(d.a) * rr;
        // step aside around the pointer, then ease back
        let gx = 0, gy = 0;
        if (pointer) {
          const dx = x - pointer.x, dy = y - pointer.y, q = dx * dx + dy * dy;
          if (q < R2 && q > 0.01) { const dist = Math.sqrt(q), f = (1 - dist / R) ** 2 * 34; gx = (dx / dist) * f; gy = (dy / dist) * f; }
        }
        d.ox += (gx - d.ox) * 0.12; d.oy += (gy - d.oy) * 0.12;
        x += d.ox; y += d.oy;
        if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
        const fade = smooth(rMin, rMin + 70, d.r) * (1 - smooth(rMax * 0.82, rMax, d.r));
        const tw = still ? 1 : 0.72 + 0.28 * Math.sin(t * 1.4 + d.tw);
        const alpha = fade * tw;
        if (alpha < 0.08) continue;
        const ang = Math.atan2(y - cy, x - cx);                       // where on screen: its colour
        const hueI = Math.floor((((ang + Math.PI / 2) / (2 * Math.PI) + 1) % 1) * HUES) % HUES;
        const alphaI = Math.min(ALPHAS - 1, Math.floor(alpha * ALPHAS));
        const dir = d.a + d.tilt, hx = Math.cos(dir) * d.len * 0.5, hy = Math.sin(dir) * d.len * 0.5;   // pointing at the middle
        paths[hueI * ALPHAS + alphaI].push(x - hx, y - hy, x + hx, y + hy);
      }
      ctx.lineCap = "round";
      ctx.lineWidth = 2;
      for (let i = 0; i < paths.length; i++) {
        const seg = paths[i];
        if (!seg.length) continue;
        ctx.strokeStyle = colours[i];
        ctx.beginPath();
        for (let j = 0; j < seg.length; j += 4) { ctx.moveTo(seg[j], seg[j + 1]); ctx.lineTo(seg[j + 2], seg[j + 3]); }
        ctx.stroke();
      }
    };

    const ro = new ResizeObserver(fit);
    ro.observe(cv);

    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!document.hidden) draw(dt);
      raf = requestAnimationFrame(frame);
    };
    if (!still) raf = requestAnimationFrame(frame);
    // a theme or accent change redraws a still field too
    const mo = new MutationObserver(() => { if (still) draw(0); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });

    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      pointer = x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null;
    };
    const onLeave = () => { pointer = null; };
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
