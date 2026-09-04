import { useCallback, useEffect, useRef, useState } from "react";

// Branded 10X Media House logo intro, played on a genuine page load — a hard
// refresh, first visit, or reopening the tab. It lives ABOVE the router (see
// main.tsx), so client-side navigation between pages never remounts it: only a
// real reload does. No "already seen" suppression — every real load plays it.
//
// It's a fixed, full-viewport overlay, NOT a gate: the app tree mounts and
// starts fetching underneath it simultaneously, so by the time the video fades
// out My Day is already sitting there ready.

const FADE_MS = 400; // opacity transition length — keep in sync with the CSS.
const START_TIMEOUT_MS = 3000; // if playback hasn't begun by now, bail out.

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function BootSplash() {
  // Reduced motion → never mount the video at all; there's no way to tone down
  // motion inside a pre-recorded clip, so full bypass is the only real option.
  const [visible, setVisible] = useState(() => !prefersReducedMotion());
  const [fading, setFading] = useState(false);
  const finishedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Fade the overlay out, then unmount it entirely (no invisible <video> left
  // sitting in the DOM). Guarded so ended/error/timeout can't double-fire it.
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFading(true);
    window.setTimeout(() => setVisible(false), FADE_MS);
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Never strand anyone on a black screen: if the video hasn't actually
    // begun playing within START_TIMEOUT_MS (stall, slow network), bail out.
    const watchdog = window.setTimeout(finish, START_TIMEOUT_MS);
    const v = videoRef.current;
    const onPlaying = () => window.clearTimeout(watchdog);
    v?.addEventListener("playing", onPlaying);
    // autoPlay + muted usually starts on its own; call play() too for the
    // browsers that need a nudge. A blocked autoplay just lets the watchdog
    // clear it — never a hang.
    v?.play?.().catch(() => {});
    return () => {
      window.clearTimeout(watchdog);
      v?.removeEventListener("playing", onPlaying);
    };
  }, [visible, finish]);

  if (!visible) return null;

  return (
    <div className={"boot-splash" + (fading ? " boot-splash--fading" : "")} aria-hidden="true">
      <video
        ref={videoRef}
        className="boot-splash-video"
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={finish}
        onError={finish}
      >
        {/* Alpha animation — VP9-alpha WebM (Chrome/Firefox/Edge). Browsers that
            can't decode it fall through to onError, which skips the splash. */}
        <source src="/media/10x-loader.webm" type="video/webm" />
      </video>
    </div>
  );
}
