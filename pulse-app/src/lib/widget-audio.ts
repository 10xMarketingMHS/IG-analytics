// The widgets' sounds, all made in the browser: no audio files, nothing to license.
// A chime is booked on the audio clock rather than a timer, so it still rings on
// time in a tab that's in the background, where the browser slows timers down.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

// Resolves once sound can play: at once after a click, else at the next one.
export function audioReady(): Promise<void> {
  const c = audio();
  if (!c) return new Promise(() => {});
  return c.state === "running" ? Promise.resolve() : c.resume();
}

// Three soft notes, `inSeconds` from now. Returns a cancel, which leaves it alone once it has started.
export function chimeAt(inSeconds = 0): () => void {
  const c = audio();
  if (!c) return () => {};
  if (c.state !== "running") c.resume().catch(() => {});
  const from = c.currentTime + Math.max(0, inSeconds);
  const oscs = [659.25, 783.99, 1046.5].map((hz, i) => {
    const t = from + i * 0.18;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 1.2);
    return o;
  });
  return () => {
    if (c.currentTime >= from) return;
    oscs.forEach((o) => { try { o.stop(); o.disconnect(); } catch { /* already stopped */ } });
  };
}

// Team chat's ping (lib/chat-alerts.ts): two quick soft notes for a message,
// three brighter ones for one meant for you (a DM, a mention, a reply to you).
export function chatPing(forYou = false) {
  const c = audio();
  if (!c) return;
  const play = () => {
    const notes = forYou ? [987.77, 1318.51, 1567.98] : [880, 1174.66];
    const from = c.currentTime + 0.02;
    notes.forEach((hz, i) => {
      const t = from + i * 0.09;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = "sine";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(forYou ? 0.2 : 0.16, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
  };
  // the browser holds sound back until the first click or key press in Echo
  if (c.state === "running") play(); else c.resume().then(play).catch(() => {});
}

export type SoundKind = "rain" | "waves" | "soft";
export const SOUNDS: { key: SoundKind; label: string; icon: string }[] = [
  { key: "rain", label: "Rain", icon: "🌧️" },
  { key: "waves", label: "Waves", icon: "🌊" },
  { key: "soft", label: "Soft noise", icon: "🌫️" },
];

// Six seconds of noise, looped. Brown is low and soft; white is bright, like rain.
function noise(c: AudioContext, brown: boolean) {
  const buf = c.createBuffer(1, c.sampleRate * 6, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    last = brown ? (last + 0.02 * w) / 1.02 : w;
    d[i] = brown ? last * 3.5 : w;
  }
  const s = c.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  return s;
}

let playing: { master: GainNode; stop: () => void } | null = null;

export function playSound(kind: SoundKind, volume: number) {
  stopSound();
  const c = audio();
  if (!c) return;
  if (c.state !== "running") c.resume().catch(() => {});
  const master = c.createGain();
  master.gain.value = 0.0001;
  master.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), c.currentTime + 1.2);
  master.connect(c.destination);
  const f = c.createBiquadFilter();
  const src = noise(c, kind !== "rain");
  const parts: AudioScheduledSourceNode[] = [src];
  if (kind === "rain") {
    f.type = "bandpass";
    f.frequency.value = 2400;
    f.Q.value = 0.4;
    src.connect(f).connect(master);
  } else if (kind === "soft") {
    f.type = "lowpass";
    f.frequency.value = 900;
    src.connect(f).connect(master);
  } else {
    // waves: the same low noise, rising and falling about every ten seconds
    f.type = "lowpass";
    f.frequency.value = 1100;
    const swell = c.createGain();
    swell.gain.value = 0.55;
    const lfo = c.createOscillator();
    const depth = c.createGain();
    lfo.frequency.value = 0.1;
    depth.gain.value = 0.45;
    lfo.connect(depth).connect(swell.gain);
    src.connect(f).connect(swell).connect(master);
    lfo.start();
    parts.push(lfo);
  }
  src.start();
  playing = {
    master,
    stop: () => {
      parts.forEach((p) => { try { p.stop(); } catch { /* already stopped */ } });
      master.disconnect();
    },
  };
}

export function setSoundVolume(volume: number) {
  if (playing && ctx) playing.master.gain.setTargetAtTime(Math.max(0.0001, volume), ctx.currentTime, 0.1);
}

export function stopSound() {
  playing?.stop();
  playing = null;
}
