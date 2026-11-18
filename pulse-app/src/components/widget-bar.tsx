import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useHeld } from "@/lib/quiet-popups";
import { mmss, PHASE_NAME, useWidgets } from "@/lib/widgets";
import { SOUNDS } from "@/lib/widget-audio";
import "./widgets.css";

// The layer along the bottom, like the top bar, while a widget is running: the
// Pomodoro, Focus Mode, a chime, a sound, or a water reminder that's on. Nothing
// running, no layer. --wb-h lets what floats above it (the break button, pop-ups)
// sit clear of it.
export function WidgetBar() {
  const w = useWidgets();
  const held = useHeld();
  const ref = useRef<HTMLDivElement>(null);
  const p = w.pomo;
  const active = !!p || w.focusOn || !!w.chime || !!w.sound || w.water.remindMins > 0;
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement.style;
    if (!active || !el) { root.setProperty("--wb-h", "0px"); return; }
    const set = () => root.setProperty("--wb-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.setProperty("--wb-h", "0px"); };
  }, [active]);
  if (!active) return null;

  const counting = !!p && !p.ended;
  const pct = counting && p ? Math.min(100, Math.max(0, 100 - (w.pomoLeft / p.total) * 100)) : 0;
  const soundName = SOUNDS.find((s) => s.key === w.sound?.kind);
  return (
    <div className="wbar" ref={ref} role="region" aria-label="Running widgets">
      {counting && <i className="wbar-line" style={{ width: `${pct}%` }} aria-hidden="true" />}
      {p && (
        <div className="wbar-item">
          <span aria-hidden="true">🍅</span>
          {p.ended ? (
            <>
              <b>{p.phase === "focus" ? "Focus done" : "Break over"}</b>
              <button type="button" className="wg-btn pri" onClick={() => w.pomoStart(w.pomoNext)}>▶ Start {PHASE_NAME[w.pomoNext].toLowerCase()}</button>
            </>
          ) : (
            <>
              <span className="wbar-name">{PHASE_NAME[p.phase]}{p.endAt ? "" : " · paused"}</span>
              <b className="wbar-time">{mmss(w.pomoLeft)}</b>
              {p.endAt
                ? <button type="button" className="wg-btn" onClick={w.pomoPause}>Pause</button>
                : <button type="button" className="wg-btn pri" onClick={w.pomoResume}>▶ Resume</button>}
            </>
          )}
          <button type="button" className="wg-btn" onClick={w.pomoStop}>Stop</button>
        </div>
      )}
      {w.focusOn && (
        <div className="wbar-item">
          <span aria-hidden="true">🎯</span>
          <span className="wbar-name">Focus Mode{held ? ` · ${held} waiting` : ""}</span>
          <button type="button" className="wg-btn" onClick={() => w.setFocus(false)}>Turn off</button>
        </div>
      )}
      {w.chime && (
        <div className="wbar-item">
          <span aria-hidden="true">⏰</span>
          <b className="wbar-time">{mmss(w.chime.endAt - w.now)}</b>
          <button type="button" className="wg-btn" onClick={w.chimeCancel}>Cancel</button>
        </div>
      )}
      {w.sound && soundName && (
        <div className="wbar-item">
          <span aria-hidden="true">{soundName.icon}</span>
          <span className="wbar-name">{soundName.label}</span>
          <button type="button" className="wg-btn" onClick={w.soundStop}>Stop</button>
        </div>
      )}
      {w.water.remindMins > 0 && (
        <div className="wbar-item">
          <span aria-hidden="true">💧</span>
          <span className="wbar-name">{w.water.count} of {w.water.target}</span>
          <button type="button" className="wg-btn" onClick={() => w.addGlass()}>+ A glass</button>
        </div>
      )}
      <Link to="/widgets" className="wbar-go">Widgets →</Link>
    </div>
  );
}
