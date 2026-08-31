import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useBreakState } from "@/lib/break-context";

// A full-screen celebratory card that appears whenever the user is on a break —
// mirrors the same break state the corner widget uses (useBreak), counts the
// remaining break budget down live, and can be dismissed (the break keeps
// running; the corner widget stays). Auto-closes when the break ends.

const QUOTES = [
  "Rest is not a reward, it's what makes you get better.",
  "Almost everything works again if you unplug it for a few minutes — including you.",
  "Take rest; a field that has rested gives a bountiful crop.",
  "Your calm mind is the ultimate weapon against your challenges.",
  "Sometimes the most productive thing you can do is step away.",
];

// Deterministic scatter of floating glyphs around the card (glyph, colour, left%,
// top%, rotation, delay, size) — fixed so it doesn't reshuffle every render.
const GLYPHS: [string, string, number, number, number, number, number][] = [
  ["♪", "#c084fc", 12, 18, -12, 0.0, 20],
  ["♫", "#f472b6", 80, 10, 10, 0.4, 24],
  ["✦", "#22d3ee", 92, 64, -8, 0.8, 18],
  ["✓", "#34d399", 6, 60, 14, 1.2, 20],
  ["♪", "#fb923c", 18, 86, -16, 1.6, 22],
  ["❯", "#60a5fa", 86, 88, 8, 2.0, 20],
  ["✧", "#a855f7", 50, 4, 0, 2.4, 22],
  ["♫", "#f472b6", 3, 38, -10, 0.6, 21],
  ["❮", "#fbbf24", 95, 40, 12, 1.0, 20],
  ["✦", "#f472b6", 70, 94, -6, 1.4, 19],
  ["♪", "#60a5fa", 30, 96, 16, 1.8, 22],
  ["✧", "#34d399", 97, 74, -14, 2.2, 18],
];

const R = 90;
const TICKS = Array.from({ length: 48 }, (_, i) => {
  const a = (i / 48) * Math.PI * 2;
  const long = i % 4 === 0;
  const r1 = long ? 101 : 104;
  return {
    x1: 110 + Math.cos(a) * r1, y1: 110 + Math.sin(a) * r1,
    x2: 110 + Math.cos(a) * 110, y2: 110 + Math.sin(a) * 110, long,
  };
});

export function BreakOverlay() {
  const { user } = useAuth();
  const { status, displayRemaining } = useBreakState();
  const onBreak = !!status?.onBreak;
  const [dismissed, setDismissed] = useState(false);

  // A fresh break re-opens the card even if the last one was dismissed.
  useEffect(() => { if (onBreak) setDismissed(false); }, [onBreak]);
  // One quote per break session, stable while it's shown.
  const quote = useMemo(() => QUOTES[Math.floor(Math.random() * QUOTES.length)], [onBreak]);

  if (!user || !onBreak || dismissed || status?.unlinked) return null;

  const cap = status?.dailyCapSeconds ?? 75 * 60;
  const remaining = Math.max(0, Math.round(displayRemaining ?? status?.remainingSeconds ?? 0));
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  // The arc and its leading glow-dot are derived from the SAME value/angle, so
  // they can never drift: an explicit path from the top (−90°) sweeping
  // clockwise by frac·360°, with the dot pinned to the arc's end point.
  const frac = Math.max(0.0001, Math.min(0.9999, remaining / cap));
  const pt = (deg: number): [number, number] => {
    const r = (deg * Math.PI) / 180;
    return [110 + R * Math.cos(r), 110 + R * Math.sin(r)];
  };
  const [sx, sy] = pt(-90);
  const [ex, ey] = pt(-90 + frac * 360);
  const arcD = `M ${sx} ${sy} A ${R} ${R} 0 ${frac > 0.5 ? 1 : 0} 1 ${ex} ${ey}`;

  return (
    <div className="brk-scrim" onClick={() => setDismissed(true)}>
      <div className="brk-card" onClick={(e) => e.stopPropagation()}>
        <button className="brk-x" title="Minimize — your break keeps running" onClick={() => setDismissed(true)}>✕</button>

        <div className="brk-glyphs" aria-hidden>
          {GLYPHS.map(([ch, color, x, y, rot, delay, size], i) => (
            <span key={i} className="brk-gy" style={{
              color, left: `${x}%`, top: `${y}%`, fontSize: size,
              ["--r" as string]: `${rot}deg`, animationDelay: `${delay}s`,
            }}>{ch}</span>
          ))}
        </div>

        <div className="brk-ring">
          <svg className="brk-ringsvg" viewBox="0 0 220 220" aria-hidden>
            <defs>
              <linearGradient id="brkArc" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#34d399" />
                <stop offset="0.5" stopColor="#a855f7" />
                <stop offset="1" stopColor="#e9d5ff" />
              </linearGradient>
              <filter id="brkDotGlow" x="-120%" y="-120%" width="340%" height="340%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <g stroke="rgba(196,181,253,.35)" strokeWidth="2">
              {TICKS.map((t, i) => (
                <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                  stroke={t.long ? "rgba(196,181,253,.55)" : undefined}
                  strokeWidth={t.long ? 2.4 : undefined} />
              ))}
            </g>
            <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(196,181,253,.12)" strokeWidth="7" />
            <path d={arcD} fill="none" stroke="url(#brkArc)" strokeWidth="7" strokeLinecap="round"
              style={{ filter: "drop-shadow(0 0 6px rgba(168,85,247,.7))" }} />
            <g transform={`translate(${ex} ${ey})`}>
              <circle r="9" fill="#eafff8" filter="url(#brkDotGlow)" />
              <circle r="5.5" fill="#fff" />
            </g>
          </svg>
          <div className="brk-cup">
            <div className="brk-cup-stage">
              <div className="brk-steam"><span className="brk-wisp w1" /><span className="brk-wisp w2" /><span className="brk-wisp w3" /></div>
              <svg viewBox="0 0 100 100" aria-hidden>
                <defs>
                  <linearGradient id="brkCupBody" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#221b31" /><stop offset=".26" stopColor="#574c76" />
                    <stop offset=".5" stopColor="#8478a6" /><stop offset=".74" stopColor="#453b60" /><stop offset="1" stopColor="#1b1528" />
                  </linearGradient>
                  <linearGradient id="brkHandle" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#6a5f8c" /><stop offset="1" stopColor="#2a2340" />
                  </linearGradient>
                  <radialGradient id="brkCoffee" cx=".4" cy=".32" r=".8">
                    <stop offset="0" stopColor="#9c6b3f" /><stop offset=".45" stopColor="#5f3c22" /><stop offset="1" stopColor="#28160c" />
                  </radialGradient>
                  <linearGradient id="brkRim" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#7d719e" /><stop offset=".5" stopColor="#d3c9ee" /><stop offset="1" stopColor="#615679" />
                  </linearGradient>
                  <radialGradient id="brkSaucer" cx=".5" cy=".35" r=".7">
                    <stop offset="0" stopColor="#544a71" /><stop offset="1" stopColor="#201a2e" />
                  </radialGradient>
                  <filter id="brkSoft"><feGaussianBlur stdDeviation="2.4" /></filter>
                </defs>
                <ellipse cx="50" cy="88" rx="30" ry="5" fill="#000" opacity=".45" filter="url(#brkSoft)" />
                <ellipse cx="50" cy="82" rx="32" ry="7.5" fill="url(#brkSaucer)" stroke="#7b6ea0" strokeOpacity=".35" />
                <path d="M70 47c14-4 14 24 0 20" fill="none" stroke="url(#brkHandle)" strokeWidth="7" strokeLinecap="round" />
                <path d="M27 41 L32 70 a18 7.5 0 0 0 36 0 L73 41 Z" fill="url(#brkCupBody)" />
                <ellipse cx="50" cy="41" rx="23" ry="8" fill="url(#brkRim)" />
                <ellipse cx="50" cy="41" rx="19" ry="6.2" fill="url(#brkCoffee)" />
                <ellipse cx="44" cy="39" rx="7.5" ry="2.2" fill="#b07a4b" opacity=".55" />
                <path d="M35 46 q3 16 7 20" stroke="#c3b7e4" strokeWidth="2.4" fill="none" opacity=".4" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        </div>

        <div className="brk-eyebrow">Take a moment for yourself ✨</div>
        <h2 className="brk-title"><span className="spark">‹</span>It's <span className="g">Break</span> Time!<span className="spark">›</span></h2>
        <div className="brk-sub">Step away, relax, and recharge.<br />You've got this! 💜</div>

        <div className="brk-div" />

        <div className="brk-remlabel">Break time remaining</div>
        <div className="brk-clock">
          <div className="brk-unit"><span className="brk-num">{mm}</span><small>min</small></div>
          <span className="brk-colon">:</span>
          <div className="brk-unit"><span className="brk-num">{ss}</span><small>sec</small></div>
        </div>

        <div className="brk-quote"><span className="qm l">“</span>{quote}<span className="qm r">”</span></div>
      </div>
    </div>
  );
}
