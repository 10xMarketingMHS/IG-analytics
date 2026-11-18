import type { CSSProperties } from "react";

// The Echo mark: the E with its two signals, drawn as shapes so it takes the
// accent colour — the E in the accent's deep tone, the signals in its light
// one, flipped for dark mode (--logo-ink / --logo-wave, index.css). Animated,
// it's the loading icon: the large signal goes out first, the small one after,
// both fading before the next round (as in the designer's
// echo-loading-icon-staggered.svg). Coordinates are the original artwork's
// pixels; the signals are arcs round one centre (524, 357.5).

const E = "M352 156H513.5A44.5 44.5 0 0 1 513.5 245H338C305 245 288 262 288 285C288 302 300 313 318 313H513.5A44.5 44.5 0 0 1 513.5 402H318C300 402 290 413 290 430C290 453 307 470 338 470H513.5A44.5 44.5 0 0 1 513.5 559H352A176 175 0 0 1 176 384V346A176 190 0 0 1 352 156Z";
const SMALL = "M597.1 262.3A120 120 0 0 1 597.1 452.7";
const LARGE = "M661 179A225 225 0 0 1 661 536";

export function EchoMark({ animated = false, className, style, title }: {
  animated?: boolean; className?: string; style?: CSSProperties; title?: string;
}) {
  return (
    <svg className={"echo-mark" + (animated ? " em-anim" : "") + (className ? " " + className : "")} style={style}
      viewBox="166 131 631 453" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path className="em-e" d={E} />
      <g className="em-sig em-l"><path className="em-w" d={LARGE} strokeWidth="75" /></g>
      <g className="em-sig em-s"><path className="em-w" d={SMALL} strokeWidth="64" /></g>
    </svg>
  );
}
