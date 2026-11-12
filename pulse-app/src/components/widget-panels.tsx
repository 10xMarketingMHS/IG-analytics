import { useEffect, useRef, useState } from "react";
import { mmss, PHASE_NAME, useWidgets, type WidgetKey } from "@/lib/widgets";
import { chimeAt, SOUNDS } from "@/lib/widget-audio";

// The widgets themselves: the same ones on the Widgets page (pages/widgets.tsx) and
// on the break screen (components/break-overlay.tsx), which recolours them.

function Num({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="wg-num">
      <span>{label}</span>
      <div className="wg-numbox">
        <button type="button" aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
        <b>{value}{unit ?? ""}</b>
        <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
      </div>
    </div>
  );
}

export function Switch({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={"wg-switch" + (on ? " on" : "")} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <i aria-hidden="true"><i /></i>
      <span>{label}{hint && <small>{hint}</small>}</span>
    </button>
  );
}

// ---- Pomodoro and Focus Mode ----
export function PomodoroPanel() {
  const w = useWidgets();
  const p = w.pomo, s = w.pomoSettings;
  const counting = !!p && !p.ended;
  const pct = counting && p ? Math.min(100, Math.max(0, 100 - (w.pomoLeft / p.total) * 100)) : 0;
  const word = !p ? "Ready to focus" : p.ended ? (p.phase === "focus" ? "Focus done" : "Break over") : !p.endAt ? `${PHASE_NAME[p.phase]} · paused` : PHASE_NAME[p.phase];
  return (
    <div className="wg-pomo">
      <div className="wg-pomo-left">
        <small>{word}</small>
        <b className="wg-pomo-time">{counting ? mmss(w.pomoLeft) : mmss((p?.ended ? s[w.pomoNext] : s.focus) * 60_000)}</b>
        <i className="wg-track" aria-hidden="true"><i style={{ width: `${pct}%` }} /></i>
        <div className="wg-row">
          {!p && <button type="button" className="wg-btn pri" onClick={() => w.pomoStart("focus")}>▶ Start focus</button>}
          {p?.ended && <button type="button" className="wg-btn pri" onClick={() => w.pomoStart(w.pomoNext)}>▶ Start {PHASE_NAME[w.pomoNext].toLowerCase()}</button>}
          {counting && p?.endAt && <button type="button" className="wg-btn" onClick={w.pomoPause}>Pause</button>}
          {counting && !p?.endAt && <button type="button" className="wg-btn pri" onClick={w.pomoResume}>▶ Resume</button>}
          {p && <button type="button" className="wg-btn" onClick={w.pomoStop}>Stop</button>}
        </div>
        <small className="wg-note">{s.done ? `${s.done} focus round${s.done === 1 ? "" : "s"} done today` : "No focus rounds yet today"} · a long break after every fourth</small>
      </div>
      <div className="wg-pomo-right">
        <div className="wg-nums">
          <Num label="Focus" value={s.focus} min={5} max={120} step={5} unit="m" onChange={(focus) => w.setPomoSettings({ focus })} />
          <Num label="Short break" value={s.short} min={1} max={60} unit="m" onChange={(short) => w.setPomoSettings({ short })} />
          <Num label="Long break" value={s.long} min={1} max={60} step={5} unit="m" onChange={(long) => w.setPomoSettings({ long })} />
        </div>
        <Switch on={w.focusOn} label="Focus Mode" hint="Holds chat and task pop-ups, and folds the sidebar. They wait in your bell and Inbox." onChange={w.setFocus} />
        <Switch on={s.linkFocus} label="Turn on with each focus round" hint="And off again when the round ends." onChange={(linkFocus) => w.setPomoSettings({ linkFocus })} />
        <small className="wg-note">This is your own timer: it doesn't touch your task timers or your break time.</small>
      </div>
    </div>
  );
}

// ---- Drink water ----
export function WaterPanel() {
  const w = useWidgets();
  const { count, target, remindMins } = w.water;
  const shown = Math.max(count, target);
  return (
    <div className="wg-stack">
      <div className="wg-glasses" role="group" aria-label={`${count} of ${target} glasses today`}>
        {Array.from({ length: Math.min(shown, 16) }, (_, i) => (
          <button key={i} type="button" className={"wg-glass" + (i < count ? " on" : "")} aria-label={`Set to ${i + 1} glasses`}
            onClick={() => w.addGlass(i + 1 - count)}>💧</button>
        ))}
      </div>
      <div className="wg-row">
        <b className="wg-big">{count} <small>of {target} today</small></b>
        <button type="button" className="wg-btn ic" aria-label="One glass less" disabled={!count} onClick={() => w.addGlass(-1)}>−</button>
        <button type="button" className="wg-btn pri" onClick={() => w.addGlass()}>+ A glass</button>
      </div>
      <div className="wg-nums">
        <Num label="Glasses a day" value={target} min={1} max={16} onChange={(t) => w.setWater({ target: t })} />
        <div className="wg-num">
          <span>Remind me</span>
          <select className="wg-select" aria-label="Water reminder" value={remindMins} onChange={(e) => w.setWater({ remindMins: Number(e.target.value) })}>
            <option value={0}>Off</option>
            <option value={30}>Every 30 min</option>
            <option value={60}>Every hour</option>
            <option value={90}>Every 90 min</option>
            <option value={120}>Every 2 hours</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ---- Stretch ----
const MOVES = [
  { icon: "🙆", name: "Neck", how: "Tilt your head to each side, slowly." },
  { icon: "🤷", name: "Shoulders", how: "Roll them back in big, slow circles." },
  { icon: "🙌", name: "Reach up", how: "Hands high. Stretch tall and breathe." },
  { icon: "🔄", name: "Back", how: "Sit tall and twist gently each way." },
  { icon: "✋", name: "Wrists", how: "Fingers up, pull back gently. Then down." },
  { icon: "🚶", name: "Legs", how: "Stand up and shake your legs out." },
];
const MOVE_SECS = 10;

export function StretchPanel() {
  const [at, setAt] = useState<number | null>(null);
  const [left, setLeft] = useState(MOVE_SECS);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (at == null) return;
    const id = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(id);
  }, [at]);
  useEffect(() => {
    if (at == null || left > 0) return;
    if (at + 1 >= MOVES.length) { setAt(null); setDone(true); chimeAt(); return; }
    setAt(at + 1);
    setLeft(MOVE_SECS);
  }, [left, at]);
  if (at == null) {
    return (
      <div className="wg-stack wg-center">
        <span className="wg-bigicon" aria-hidden="true">{done ? "🌟" : "🧘"}</span>
        <p>{done ? "That's your minute. Feels better?" : `${MOVES.length} easy moves, ${MOVE_SECS} seconds each.`}</p>
        <button type="button" className="wg-btn pri" onClick={() => { setDone(false); setLeft(MOVE_SECS); setAt(0); }}>{done ? "Again" : "▶ Start"}</button>
      </div>
    );
  }
  const m = MOVES[at];
  return (
    <div className="wg-stack wg-center">
      <span className="wg-bigicon" aria-hidden="true">{m.icon}</span>
      <b className="wg-big">{m.name} <small>{left}s</small></b>
      <p>{m.how}</p>
      <div className="wg-dots" aria-label={`Move ${at + 1} of ${MOVES.length}`}>{MOVES.map((x, i) => <i key={x.name} className={i <= at ? "on" : ""} />)}</div>
      <div className="wg-row">
        <button type="button" className="wg-btn" onClick={() => setLeft(0)}>Next</button>
        <button type="button" className="wg-btn" onClick={() => { setAt(null); setDone(false); }}>Stop</button>
      </div>
    </div>
  );
}

// ---- Chime me back ----
export function ChimePanel() {
  const w = useWidgets();
  if (w.chime) {
    return (
      <div className="wg-stack wg-center">
        <b className="wg-pomo-time">{mmss(w.chime.endAt - w.now)}</b>
        <p>It chimes when this runs out.</p>
        <button type="button" className="wg-btn" onClick={w.chimeCancel}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="wg-stack">
      <p>Chime me back in:</p>
      <div className="wg-row">
        {[5, 10, 15, 30].map((m) => <button key={m} type="button" className="wg-btn" onClick={() => w.chimeStart(m)}>{m} min</button>)}
      </div>
    </div>
  );
}

// ---- Quick note ----
export function NotePanel() {
  const w = useWidgets();
  return (
    <div className="wg-stack">
      <textarea className="wg-text" rows={4} maxLength={2000} value={w.note} placeholder="Call the client about the Diwali reel" aria-label="Quick note"
        onChange={(e) => w.setNote(e.target.value)} />
      <div className="wg-row">
        <small className="wg-note">Saved as you type. It shows when you're back from a break.</small>
        {!!w.note && <button type="button" className="wg-btn" onClick={() => w.setNote("")}>Clear</button>}
      </div>
    </div>
  );
}

// ---- Relax sounds ----
export function SoundsPanel() {
  const w = useWidgets();
  return (
    <div className="wg-stack">
      <div className="wg-row">
        {SOUNDS.map((s) => (
          <button key={s.key} type="button" className={"wg-btn" + (w.sound?.kind === s.key ? " pri" : "")} aria-pressed={w.sound?.kind === s.key}
            onClick={() => (w.sound?.kind === s.key ? w.soundStop() : w.soundPlay(s.key))}>{s.icon} {s.label}</button>
        ))}
      </div>
      {w.sound ? (
        <label className="wg-num">
          <span>Volume</span>
          <input type="range" min={5} max={100} value={Math.round(w.sound.volume * 100)} aria-label="Volume" onChange={(e) => w.soundVolume(Number(e.target.value) / 100)} />
        </label>
      ) : <small className="wg-note">Made in your browser. Tap one to play, tap it again to stop.</small>}
    </div>
  );
}

// ---- Memory game ----
const FACES = ["☕", "🌿", "🎬", "🎧", "⭐", "🍎"];
const deal = () => [...FACES, ...FACES].map((v) => ({ v, r: Math.random() })).sort((a, b) => a.r - b.r).map((x) => x.v);

export function MemoryGame() {
  const [cards, setCards] = useState(deal);
  const [open, setOpen] = useState<number[]>([]);
  const [matched, setMatched] = useState<string[]>([]);
  const [moves, setMoves] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const won = matched.length === FACES.length;
  function flip(i: number) {
    if (open.length === 2 || open.includes(i) || matched.includes(cards[i])) return;
    const next = [...open, i];
    setOpen(next);
    if (next.length < 2) return;
    setMoves((m) => m + 1);
    if (cards[next[0]] === cards[next[1]]) {
      setMatched((m) => [...m, cards[i]]);
      setOpen([]);
    } else {
      timer.current = setTimeout(() => setOpen([]), 800);
    }
  }
  return (
    <div className="wg-stack">
      <div className="wg-cards">
        {cards.map((c, i) => {
          const up = open.includes(i) || matched.includes(c);
          return <button key={i} type="button" className={"wg-mcard" + (up ? " up" : "")} aria-label={up ? c : `Card ${i + 1}`} onClick={() => flip(i)}>{up ? c : ""}</button>;
        })}
      </div>
      <div className="wg-row">
        <small className="wg-note">{won ? `All matched in ${moves} moves.` : `${moves} move${moves === 1 ? "" : "s"}`}</small>
        <button type="button" className="wg-btn" onClick={() => { clearTimeout(timer.current); setCards(deal()); setOpen([]); setMatched([]); setMoves(0); }}>{won ? "Play again" : "New game"}</button>
      </div>
    </div>
  );
}

export function WidgetPanel({ k }: { k: WidgetKey }) {
  switch (k) {
    case "water": return <WaterPanel />;
    case "stretch": return <StretchPanel />;
    case "chime": return <ChimePanel />;
    case "note": return <NotePanel />;
    case "sounds": return <SoundsPanel />;
    case "game": return <MemoryGame />;
  }
}
