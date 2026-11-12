import { useEffect, useState } from "react";
import { EchoMark } from "@/components/echo-logo";

// The loading screen on a genuine page load — a hard refresh, first visit, or
// reopening the tab: the Echo mark, its signals going out once (1.8 s), then
// it fades. It lives ABOVE the router (see main.tsx), so client-side
// navigation between pages never remounts it: only a real reload does.
//
// It's a fixed, full-viewport overlay, NOT a gate: the app tree mounts and
// starts fetching underneath it simultaneously, so by the time it fades out
// My Day is already sitting there ready.

const SHOW_MS = 1900; // one round of the signals, and a breath
const FADE_MS = 400; // opacity transition length — keep in sync with the CSS.

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function BootSplash() {
  // Reduced motion: no loading screen at all.
  const [visible, setVisible] = useState(() => !prefersReducedMotion());
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const fade = window.setTimeout(() => {
      setFading(true);
      // Signal the app that the splash is done, so the My Day hero intro clip
      // waits and plays AFTER the splash instead of behind it. Fired as the
      // splash starts fading so the intro can pick up during the crossfade.
      try {
        (window as unknown as { __pulseBootDone?: boolean }).__pulseBootDone = true;
        window.dispatchEvent(new Event("pulse:bootdone"));
      } catch { /* non-browser / older env — the hero has its own safety timeout */ }
    }, SHOW_MS);
    const gone = window.setTimeout(() => setVisible(false), SHOW_MS + FADE_MS);
    return () => { window.clearTimeout(fade); window.clearTimeout(gone); };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={"boot-splash" + (fading ? " boot-splash--fading" : "")} aria-hidden="true">
      <EchoMark animated className="boot-splash-mark" />
    </div>
  );
}
