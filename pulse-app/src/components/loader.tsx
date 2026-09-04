import { useState } from "react";

// Branded loading animation — the 10X Media House alpha clip, looping. One
// shared component for the app's meaningful loading states (full-screen app
// boot, page/section placeholders). Alpha video composites over whatever's
// behind it, so it drops onto any background cleanly.
//
// Uses a VP9-alpha WebM (Chrome/Firefox/Edge). Browsers that can't decode it
// fall back to just the label — never a black box.

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function Loader({
  size = 160,
  label = "Loading…",
  fullscreen = false,
}: {
  size?: number;
  label?: string | null;
  fullscreen?: boolean;
}) {
  // No looping video under reduced motion — fall back to the plain label.
  const [reduced] = useState(prefersReducedMotion);
  return (
    <div className={"loader" + (fullscreen ? " loader--full" : "")} role="status" aria-live="polite">
      {!reduced && (
        <video
          className="loader-video"
          style={{ width: size }}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden
        >
          <source src="/media/10x-loader.webm" type="video/webm" />
        </video>
      )}
      {label && <div className="loader-label">{label}</div>}
    </div>
  );
}
