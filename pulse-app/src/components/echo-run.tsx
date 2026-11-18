import { useEffect, useRef, useState, type MouseEvent } from "react";

// Echo Run — a one-button runner on the sign-in screen (login.tsx), Echo's
// own little game: the Echo orb rolls along, jumps the blocks and catches the
// sparks, a little faster all the time. Until Play is pressed the panel is
// just its moving colours; the game fades in for a round and back out after
// it. Play and the score sit in the panel's top-right corner. During a round,
// Space / ↑ / a tap jump (held for a higher one) — never while you're typing
// in the form. Best score kept per browser.

type Block = { x: number; w: number; h: number };
type Spark = { x: number; y: number; got: boolean };
type Phase = "idle" | "run" | "over";

const BEST_KEY = "pulse:runBest";
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const saveBest = (n: number) => { try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* private window */ } };
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pad = (n: number) => String(n).padStart(5, "0");

// physics, in px and seconds
const R = 13;          // the orb
const GRAVITY = 2400;
const JUMP = 760;      // up to ~120px high
const CUT = 300;       // let go early: a lower hop
const START = 320;     // speed, px/s…
const TOP = 720;       // …climbing to this
const LINGER = 1100;   // ms the crash stays on screen before the game fades out

// typing in the form (or on a button) never jumps
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName));

const PLAY = (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" /></svg>
);

export function EchoRun() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scoreEl = useRef<HTMLElement>(null);   // the running score, written by the loop (no re-render per frame)
  const [phase, setPhase] = useState<Phase>("idle");
  const [shown, setShown] = useState(false);   // the game on screen (a round, and the moment after)
  const [result, setResult] = useState({ score: 0, best: readBest() });
  const startRound = useRef(() => {});

  useEffect(() => {
    const box = wrap.current, cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!box || !cv || !ctx) return;
    // the colours come from the panel (login.css --run-*): dark ink on the light
    // theme, light on the dark one; read again when the theme or accent changes
    const readPalette = () => {
      const cs = getComputedStyle(box), v = (name: string, or: string) => cs.getPropertyValue(name).trim() || or;
      return {
        line: v("--run-line", "rgba(255,255,255,.7)"), dash: v("--run-dash", "rgba(255,255,255,.4)"),
        orb: v("--run-orb", "#fff"), mark: v("--run-mark", "#7c3aed"), glow: v("--run-glow", "rgba(255,255,255,.9)"), trail: v("--run-trail", "#fff"),
        block: v("--run-block", "rgba(255,255,255,.86)"), blockLine: v("--run-block-line", "rgba(40,20,110,.28)"),
        shadow: v("--run-shadow", "rgba(30,10,80,.35)"), spark: v("--run-spark", "#ffe08a"),
      };
    };
    let pal = readPalette();
    const themeWatch = new MutationObserver(() => { pal = readPalette(); painted = false; });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });

    let W = 0, H = 0;
    const fit = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      painted = false;
    };
    let painted = false;   // the last frame is still on the canvas (it fades out with it)
    const ro = new ResizeObserver(fit);
    ro.observe(cv);

    let mode: Phase = "idle";
    let y = 0, vy = 0, onGround = true;               // y: height above the ground
    let speed = START, dist = 0, bonus = 0, gap = 0, roll = 0, clock = 0, shownScore = -1;
    let blocks: Block[] = [], sparks: Spark[] = [], trail: number[] = [];
    let best = readBest();
    let hideTimer = 0;
    const ground = () => H - 24;
    const orbX = () => Math.max(56, W * 0.16);
    const score = () => Math.floor(dist / 12) + bonus;

    const reset = () => {
      y = 0; vy = 0; onGround = true; speed = START; dist = 0; bonus = 0; roll = 0; shownScore = -1;
      blocks = []; sparks = []; trail = []; gap = Math.max(W * 0.9, 360); // a run-up before the first block
    };
    // a round starts only from the Play button; keys and taps just jump
    startRound.current = () => {
      window.clearTimeout(hideTimer);
      pal = readPalette();
      reset(); mode = "run";
      setPhase("run"); setShown(true);
    };
    const press = () => { if (mode === "run" && onGround) { vy = JUMP; onGround = false; } };
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
      const now = score();
      if (now !== shownScore && scoreEl.current) { scoreEl.current.textContent = pad(now); shownScore = now; }
      if (blocks.some(hits)) {
        mode = "over";
        if (now > best) { best = now; saveBest(best); }
        setResult({ score: now, best });
        setPhase("over");
        // the crash stays a moment, then the panel is colours again
        hideTimer = window.setTimeout(() => setShown(false), LINGER);
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const g = ground(), ox = orbX();
      // the ground: a line and dots rolling past
      ctx.save();
      ctx.shadowColor = pal.shadow; ctx.shadowBlur = 6;
      ctx.strokeStyle = pal.line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, g + 0.5); ctx.lineTo(W, g + 0.5); ctx.stroke();
      ctx.fillStyle = pal.dash;
      for (let x = -(dist % 28); x < W; x += 28) ctx.fillRect(x, g + 8, 10, 2);
      ctx.restore();
      // sparks
      for (const s of sparks) {
        if (s.got) continue;
        const sy = g - s.y, k = 5 + Math.sin(clock * 8 + s.x * 0.05) * 1.2;
        ctx.save();
        ctx.translate(s.x, sy); ctx.rotate(clock * 2);
        ctx.shadowColor = pal.spark; ctx.shadowBlur = 12;
        ctx.fillStyle = pal.spark;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, rr = i % 2 ? k * 0.38 : k; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      // blocks: frosted glass
      for (const b of blocks) {
        ctx.save();
        ctx.shadowColor = pal.shadow; ctx.shadowBlur = 10;
        ctx.fillStyle = pal.block;
        ctx.strokeStyle = pal.blockLine; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(b.x, g - b.h, b.w, b.h, 6); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      // the orb: a trail, a glow, the Echo half-moon turning as it rolls
      const cy = g - R - y;
      ctx.save();
      ctx.fillStyle = pal.trail;
      trail.forEach((ty, i) => {
        ctx.globalAlpha = 0.22 - i * 0.022;
        ctx.beginPath(); ctx.arc(ox - (i + 1) * 7, ty, R * (1 - i * 0.07), 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
      ctx.save();
      ctx.shadowColor = pal.glow; ctx.shadowBlur = 18;
      ctx.fillStyle = pal.orb;
      ctx.beginPath(); ctx.arc(ox, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(ox, cy); ctx.rotate(roll);
      ctx.fillStyle = pal.mark;
      ctx.beginPath(); ctx.arc(0, 0, R - 3, Math.PI / 2, (3 * Math.PI) / 2); ctx.closePath(); ctx.fill();
      ctx.restore();
      painted = true;
    };

    // drawn only during a round (and its last frame kept while it fades out)
    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      if (!document.hidden) {
        step(dt);
        if (mode === "run" || (mode === "over" && !painted)) draw();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onVis = () => { last = performance.now(); };

    const isJump = (e: KeyboardEvent) => e.code === "Space" || e.key === " " || e.key === "ArrowUp";
    const onKeyDown = (e: KeyboardEvent) => {
      if (mode !== "run" || !isJump(e) || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) press();
    };
    const onKeyUp = (e: KeyboardEvent) => { if (isJump(e)) release(); };
    const onDown = (e: PointerEvent) => {
      if (mode !== "run") return;
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
      window.clearTimeout(hideTimer);
      ro.disconnect();
      themeWatch.disconnect();
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

  // Play: start, then keep the keys on the game (a click leaves no focus ring)
  const play = (e: MouseEvent<HTMLButtonElement>) => {
    const box = wrap.current;
    if (box) {
      if (e.detail > 0) box.dataset.pointer = ""; else delete box.dataset.pointer;
      box.focus({ preventScroll: true });
    }
    startRound.current();
  };

  return (
    <>
      <div className="lg-game" ref={wrap} tabIndex={-1} data-on={shown || undefined} role="application"
        aria-label="Echo Run, a mini game: press Play, then Space or tap to jump over the blocks and catch the sparks">
        <canvas ref={canvas} />
      </div>
      {/* top-right of the panel: Play, the score while playing, the result after */}
      <div className="lg-gamebar" aria-live="polite">
        {phase === "run" ? (
          <span className="lg-score"><b ref={scoreEl}>{pad(0)}</b>{result.best > 0 && <span>Best {result.best}</span>}</span>
        ) : (
          <>
            {phase === "over" && (
              <span className="lg-score over"><b>Game over · {result.score}</b><span>Best {result.best}</span></span>
            )}
            <button type="button" className="lg-play" onClick={play} title="Play Echo Run: jump the blocks, catch the sparks (Space, ↑ or a tap)">
              {PLAY}{phase === "over" ? "Play again" : "Play"}
            </button>
          </>
        )}
      </div>
    </>
  );
}
