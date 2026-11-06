import { EchoMark } from "@/components/echo-logo";

// Loading animation — the Echo mark with its signals going out, on a loop. One
// shared component for the app's meaningful loading states (full-screen app
// boot, page/section placeholders). Drawn in the accent colour, so it sits on
// any background; under reduced motion the mark stays still (index.css).

export function Loader({
  size = 160,
  label = "Loading…",
  fullscreen = false,
}: {
  size?: number;
  label?: string | null;
  fullscreen?: boolean;
}) {
  return (
    <div className={"loader" + (fullscreen ? " loader--full" : "")} role="status" aria-live="polite">
      <EchoMark animated className="loader-mark" style={{ width: Math.round(size * 0.45) }} />
      {label && <div className="loader-label">{label}</div>}
    </div>
  );
}
