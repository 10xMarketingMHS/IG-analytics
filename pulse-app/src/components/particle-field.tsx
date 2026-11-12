import { useEffect, useRef } from "react";

// A field of small dashes on rings around one point, each pointing at the
// middle, turning slowly — the inner rings faster. The field itself stays put;
// the pointer opens a soft lens in it: the dashes near it spread out and
// gather in a ring around it, as one smooth bend (none flips from one side of
// the pointer to the other); the lens glides after the pointer and each dash
// eases into its place, so a quick flick of the mouse doesn't jolt. Colour
// comes from where a dash is around the middle (blue, violet, pink, orange…),
// shifted toward the person's accent, and the colours travel round on their
// own, once every SWEEP seconds. Used behind the sign-in panel (login.tsx);
// drawn on a canvas, still for reduced motion.

type Dash = { r: number; a: number; len: number; sp: number; tw: number; tilt: number; ox: number; oy: number };

const HUES = 60;      // colours are batched: one path per hue and alpha step
const ALPHAS = 6;
const SWEEP = 30;     // seconds for the colours to go once round
const LENS = 1.7;     // how far the lens spreads the dashes (under 2.2, so none cross over)
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// the share of the way to go this frame: the same glide at any frame rate
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

// angle round the middle (0 = top, going clockwise, 0…1) → hue
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
    let rMin = 0, rMax = 0, cx = 0, cy = 0, sigma = 60;
    // the pointer over the panel (null when it isn't), and the lens gliding after it
    let pointer: { x: number; y: number } | null = null;
    let lx = 0, ly = 0, lens = 0;

    const build = () => {
      dashes = [];
      cx = W * 0.56; cy = H * 0.4;
      rMin = Math.max(60, Math.min(W, H) * 0.2);         // an open middle
      rMax = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.02;
      sigma = Math.max(48, Math.min(W, H) * 0.09);         // the lens: about 1.7× this across its open middle
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

    // the colours for this theme and accent, worked out again only when either changes
    let colours: string[] = [];
    let dirty = true;
    const palette = () => {
      dirty = false;
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const ac = Number(getComputedStyle(document.documentElement).getPropertyValue("--acH")) || 290;
      const shift = (ac - 290) * 0.45, L = dark ? 0.74 : 0.6, C = dark ? 0.17 : 0.21;
      colours = [];
      for (let h = 0; h < HUES; h++) {
        const hue = (hueAt(h / HUES) + shift + 360) % 360;
        for (let s = 0; s < ALPHAS; s++) colours.push(`oklch(${L} ${C} ${hue.toFixed(1)} / ${(((s + 1) / ALPHAS) * (dark ? 0.95 : 0.9)).toFixed(3)})`);
      }
    };

    const paths: number[][] = Array.from({ length: HUES * ALPHAS }, () => []);
    let t = 0;
    const draw = (dt: number) => {
      if (dirty) palette();
      t += dt;
      ctx.clearRect(0, 0, W, H);
      for (const p of paths) p.length = 0;
      // the lens: it appears where the pointer comes in, glides after it, and fades when it leaves
      if (pointer) {
        if (lens === 0) { lx = pointer.x; ly = pointer.y; }
        const k = ease(7, dt);
        lx += (pointer.x - lx) * k; ly += (pointer.y - ly) * k;
      }
      lens += ((pointer ? 1 : 0) - lens) * ease(4, dt);
      if (!pointer && lens < 0.002) lens = 0;
      const S2 = sigma * sigma, reach = S2 * 9;             // past 3σ the bend is nothing
      const turn = still ? 0 : t / SWEEP, settle = ease(5, dt);
      for (const d of dashes) {
        if (!still) d.a += (0.05 + 5 / d.r) * d.sp * dt;
        const rr = d.r * (1 + (still ? 0 : 0.012 * Math.sin(t * 0.5 + d.r * 0.012)));
        let x = cx + Math.cos(d.a) * rr, y = cy + Math.sin(d.a) * rr;
        // spread out around the pointer: the nearer, the further (a smooth bend, no edge),
        // eased into, and back out of when the pointer leaves
        let thin = 1, gx = 0, gy = 0;
        if (lens > 0) {
          const dx = x - lx, dy = y - ly, q = dx * dx + dy * dy;
          if (q < reach) {
            const s = LENS * lens * Math.exp(-q / S2);
            gx = dx * s; gy = dy * s;
            thin = 1 - lens * (1 - smooth(S2 * 0.05, S2 * 0.6, q));   // the very middle clears
          }
        }
        d.ox += (gx - d.ox) * settle; d.oy += (gy - d.oy) * settle;
        x += d.ox; y += d.oy;
        if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
        const fade = smooth(rMin, rMin + 70, d.r) * (1 - smooth(rMax * 0.82, rMax, d.r));
        const tw = still ? 1 : 0.8 + 0.2 * Math.sin(t * 0.9 + d.tw);
        const alpha = fade * tw * thin;
        if (alpha < 0.06) continue;
        const ang = Math.atan2(y - cy, x - cx);                        // where round the middle: its colour
        const at = (((ang + Math.PI / 2) / (2 * Math.PI) - turn) % 1 + 1) % 1;
        const hueI = Math.floor(at * HUES) % HUES;
        const alphaI = Math.min(ALPHAS - 1, Math.max(0, Math.round(alpha * ALPHAS) - 1));
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
    // a theme or accent change: new colours (and a redraw, when the field is still)
    const mo = new MutationObserver(() => { dirty = true; if (still) draw(0); });
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
