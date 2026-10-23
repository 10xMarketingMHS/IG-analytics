import { useEffect, useRef } from "react";

// Pulse Run — a one-button runner on the sign-in screen (login.tsx), Pulse's
// own little game: the Pulse orb rolls along, jumps the blocks and catches the
// sparks, a little faster all the time. Space / ↑ / a tap to jump, held for a
// higher one. Never while you're typing in the form. Best score kept per browser.

type Block = { x: number; w: number; h: number };
type Spark = { x: number; y: number; got: boolean };

const BEST_KEY = "pulse:runBest";
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const saveBest = (n: number) => { try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* private window */ } };
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// physics, in px and seconds
const R = 13;          // the orb
const GRAVITY = 2400;
const JUMP = 760;      // up to ~120px high
const CUT = 300;       // let go early: a lower hop
const START = 320;     // speed, px/s…
const TOP = 720;       // …climbing to this

// typing in the form (or on a button) never jumps
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName));

export function PulseRun() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = wrap.current, cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!box || !cv || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c3aed";

    let W = 0, H = 0;
    const fit = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    fit();

    let mode: "idle" | "run" | "over" = "idle";
    let y = 0, vy = 0, onGround = true;               // y: height above the ground
    let speed = START, dist = 0, bonus = 0, gap = 0, roll = 0, clock = 0, overAt = 0;
    let blocks: Block[] = [], sparks: Spark[] = [], trail: number[] = [];
    let best = readBest();
    const ground = () => H - 24;
    const orbX = () => Math.max(56, W * 0.16);
    const score = () => Math.floor(dist / 12) + bonus;

    const reset = () => {
      y = 0; vy = 0; onGround = true; speed = START; dist = 0; bonus = 0; roll = 0;
      blocks = []; sparks = []; trail = []; gap = Math.max(W * 0.9, 360); // a run-up before the first block
    };
    const press = () => {
      if (mode === "over" && performance.now() - overAt < 400) return; // a held key doesn't restart at once
      if (mode !== "run") { reset(); mode = "run"; }
      if (onGround) { vy = JUMP; onGround = false; }
    };
    const release = () => { if (vy > CUT) vy = CUT; };

    const spawn = () => {
      const tall = Math.min(56, H * 0.22);
      const w = rand(16, 30), h = rand(22, tall);
      blocks.push({ x: W + 20, w, h });
      if (speed > 430 && Math.random() < 0.22) blocks.push({ x: W + 20 + w + 7, w: rand(14, 22), h: rand(20, tall * 0.8) });
      const next = rand(speed * 0.8, speed * 1.6) + W * 0.12;
      if (Math.random() < 0.45) sparks.push({ x: W + 20 + next / 2, y: rand(62, 104), got: false });
      gap = next;
    };

    const hits = (b: Block) => {
      const cx = orbX(), cy = ground() - R - y, r = R * 0.82;
      const nx = Math.max(b.x, Math.min(cx, b.x + b.w)), ny = Math.max(ground() - b.h, Math.min(cy, ground()));
      return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
    };

    const step = (dt: number) => {
      clock += dt;
      if (mode !== "run") return;
      speed = Math.min(TOP, speed + 9 * dt);
      dist += speed * dt;
      roll += (speed * dt) / R;
      vy -= GRAVITY * dt; y += vy * dt;
      if (y <= 0) { y = 0; vy = 0; onGround = true; }
      for (const b of blocks) b.x -= speed * dt;
      for (const s of sparks) s.x -= speed * dt;
      blocks = blocks.filter((b) => b.x + b.w > -10);
      sparks = sparks.filter((s) => s.x > -10);
      gap -= speed * dt;
      if (gap <= 0) spawn();
      trail.unshift(ground() - R - y);
      if (trail.length > 9) trail.pop();
      for (const s of sparks) {
        if (!s.got && Math.hypot(orbX() - s.x, ground() - R - y - (ground() - s.y)) < R + 8) { s.got = true; bonus += 10; }
      }
      if (blocks.some(hits)) {
        mode = "over"; overAt = performance.now();
        if (score() > best) { best = score(); saveBest(best); }
      }
    };

    const text = (s: string, x: number, yy: number, size: number, weight = 700, align: CanvasTextAlign = "center", alpha = 1) => {
      ctx.save();
      ctx.font = `${weight} ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = align; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(20,10,60,.55)"; ctx.shadowBlur = 10;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillText(s, x, yy);
      ctx.restore();
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const g = ground(), ox = orbX();
      // the ground: a line and dots rolling past
      ctx.save();
      ctx.shadowColor = "rgba(20,10,60,.35)"; ctx.shadowBlur = 6;
      ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, g + 0.5); ctx.lineTo(W, g + 0.5); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.4)";
      for (let x = -(dist % 28); x < W; x += 28) ctx.fillRect(x, g + 8, 10, 2);
      ctx.restore();
      // sparks
      for (const s of sparks) {
        if (s.got) continue;
        const sy = g - s.y, k = 5 + Math.sin(clock * 8 + s.x * 0.05) * 1.2;
        ctx.save();
        ctx.translate(s.x, sy); ctx.rotate(clock * 2);
        ctx.shadowColor = "rgba(255,214,120,.9)"; ctx.shadowBlur = 12;
        ctx.fillStyle = "#ffe08a";
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, rr = i % 2 ? k * 0.38 : k; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      // blocks: frosted glass
      for (const b of blocks) {
        ctx.save();
        ctx.shadowColor = "rgba(30,10,80,.35)"; ctx.shadowBlur = 10;
        ctx.fillStyle = "rgba(255,255,255,.86)";
        ctx.strokeStyle = "rgba(40,20,110,.28)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(b.x, g - b.h, b.w, b.h, 6); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      // the orb: a trail, a glow, the Pulse half-moon turning as it rolls
      const bob = mode === "idle" && !still ? Math.abs(Math.sin(clock * 3)) * 10 : 0;
      const cy = g - R - (mode === "idle" ? bob : y);
      trail.forEach((ty, i) => {
        ctx.fillStyle = `rgba(255,255,255,${0.22 - i * 0.022})`;
        ctx.beginPath(); ctx.arc(ox - (i + 1) * 7, ty, R * (1 - i * 0.07), 0, Math.PI * 2); ctx.fill();
      });
      ctx.save();
      ctx.shadowColor = "rgba(255,255,255,.9)"; ctx.shadowBlur = 18;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(ox, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(ox, cy); ctx.rotate(roll);
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(0, 0, R - 3, Math.PI / 2, (3 * Math.PI) / 2); ctx.closePath(); ctx.fill();
      ctx.restore();
      // words
      if (mode !== "idle") {
        text(String(score()).padStart(5, "0"), W - 22, 22, 15, 800, "right");
        if (best) text(`Best ${best}`, W - 22, 42, 11.5, 600, "right", 0.8);
      }
      const mid = Math.max(40, (g - 60) / 2);
      if (mode === "idle") {
        text("Tap or press Space to play", W / 2, mid, 15);
        text("Jump the blocks · catch the sparks", W / 2, mid + 22, 12, 500, "center", 0.85);
      } else if (mode === "over") {
        text("Game over", W / 2, mid - 6, 18, 800);
        text(`Score ${score()}${best ? ` · Best ${best}` : ""}`, W / 2, mid + 18, 12.5, 600, "center", 0.9);
        text("Tap or press Space to play again", W / 2, mid + 38, 12, 500, "center", 0.8);
      }
    };

    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      if (!document.hidden) { step(dt); draw(); }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onVis = () => { last = performance.now(); };

    const isJump = (e: KeyboardEvent) => e.code === "Space" || e.key === " " || e.key === "ArrowUp";
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isJump(e) || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) press();
    };
    const onKeyUp = (e: KeyboardEvent) => { if (isJump(e)) release(); };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      if (typing(document.activeElement)) (document.activeElement as HTMLElement).blur();
      box.dataset.pointer = ""; // focused by a tap: no keyboard ring (login.css)
      box.focus({ preventScroll: true });
      press();
    };

    const onBlur = () => { delete box.dataset.pointer; };
    box.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", onVis);
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointerup", release);
    cv.addEventListener("pointercancel", release);
    cv.addEventListener("pointerleave", release);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      box.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVis);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointerup", release);
      cv.removeEventListener("pointercancel", release);
      cv.removeEventListener("pointerleave", release);
    };
  }, []);

  return (
    <div className="lg-game" ref={wrap} tabIndex={0} role="application"
      aria-label="Pulse Run, a mini game: press Space or tap to jump over the blocks and catch the sparks">
      <canvas ref={canvas} />
    </div>
  );
}
