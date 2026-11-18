import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { API_BASE, ApiError, NO_ANSWER, getActiveWorkspaceId } from "@/lib/api";
import { clipLength } from "@/lib/chat";

// Team Chat voice messages (server/src/routes/chat.js): record in the message
// box and send, press play on one in a conversation. Up to 2 minutes each;
// the server keeps the sound for 30 days.

export const VOICE_MAX_MS = 120_000;
// what each browser records best: Chrome, Edge, Firefox (Opus), Safari (AAC)
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

const svg = (children: ReactNode, size = 18) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
);
export const MIC_ICON = svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
const ICON = {
  trash: svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2M19 6l-1 14H6L5 6" /></>),
  send: svg(<path d="m22 2-7 20-4-9-9-4Z" />),
  play: <svg className="ic vp-solid" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>,
  pause: <svg className="ic vp-solid" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>,
  mic: svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>, 15),
};

// This browser can record (and the page is on https or this computer).
export function canRecord() {
  return typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

function micTrouble(err: unknown) {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Echo isn't allowed to use your microphone. Allow it for this site (the icon at the left of the address bar), then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this computer.";
  if (name === "NotReadableError") return "Your microphone is busy in another app. Close that app's call, then try again.";
  return "Couldn't start recording. Try again.";
}

type Phase = "starting" | "recording" | "ready" | "sending";

// Recording in the message box: it starts at once, shows the time and your
// voice's level, stops itself at 2 minutes. Delete throws it away; Send sends.
export function VoiceRecorder({ onSend, onClose }: {
  onSend: (audio: Blob, ms: number) => Promise<void>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [ms, setMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(32).fill(0));
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const clip = useRef<Blob | null>(null);
  const stopped = useRef<Promise<void> | null>(null);
  const started = useRef(0);
  const took = useRef(0);
  const meter = useRef<number | undefined>(undefined);
  const gone = useRef(false);

  function release() {
    window.clearInterval(meter.current);
    stream.current?.getTracks().forEach((t) => t.stop());
  }
  // Stop recording (if it still is) and wait for the last of the sound.
  async function stop() {
    const r = rec.current;
    if (r && r.state !== "inactive") {
      took.current = Math.min(performance.now() - started.current, VOICE_MAX_MS);
      r.stop();
    }
    window.clearInterval(meter.current);
    await stopped.current;
    release();
  }

  useEffect(() => {
    // this start's own flag: React may start and stop a component once more
    // than it seems (development), and only the start still on screen records
    let alive = true;
    gone.current = false;
    let ctx: AudioContext | null = null;
    (async () => {
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (err) {
        if (alive) { toast.error(micTrouble(err)); onClose(); }
        return;
      }
      if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
      stream.current = s;
      try {
        const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
        const r = new MediaRecorder(s, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 24_000 });
        rec.current = r;
        r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
        stopped.current = new Promise((done) => {
          r.onstop = () => { clip.current = new Blob(chunks.current, { type: r.mimeType || type || "audio/webm" }); done(); };
        });
        r.start(1000);
      } catch (err) {
        release();
        toast.error(micTrouble(err));
        onClose();
        return;
      }
      started.current = performance.now();
      setPhase("recording");
      // the level meter, and the 2-minute stop
      let an: AnalyserNode | null = null;
      try {
        ctx = new AudioContext();
        an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(an);
      } catch { an = null; }
      const buf = new Uint8Array(512);
      meter.current = window.setInterval(() => {
        const now = performance.now() - started.current;
        setMs(Math.min(now, VOICE_MAX_MS));
        if (an) {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
          const level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
          setLevels((l) => [...l.slice(1), level]);
        }
        if (now >= VOICE_MAX_MS) stop().then(() => { if (alive) setPhase("ready"); });
      }, 100);
    })();
    return () => {
      alive = false;
      gone.current = true;
      const r = rec.current;
      if (r && r.state !== "inactive") r.stop();
      release();
      ctx?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    if (phase === "starting" || phase === "sending") return;
    setPhase("sending");
    await stop();
    const audio = clip.current;
    if (!audio || !audio.size || took.current < 500) {
      toast.error(took.current < 500 ? "That was too short to send." : "Nothing was recorded. Check your microphone.");
      onClose();
      return;
    }
    try {
      await onSend(audio, Math.round(took.current));
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't send the voice message. Try again.");
      if (!gone.current) setPhase("ready");
    }
  }

  const note = phase === "starting" ? "Starting the microphone…"
    : phase === "sending" ? "Sending…"
    : phase === "ready" ? (took.current >= VOICE_MAX_MS ? "2-minute limit reached" : "Not sent yet")
    : "Recording · up to 2:00";
  return (
    <div className="vr" role="group" aria-label="Voice message">
      <button type="button" className="vr-del" title="Delete recording" aria-label="Delete recording" disabled={phase === "sending"} onClick={onClose}>{ICON.trash}</button>
      <span className={"vr-dot" + (phase === "recording" ? " on" : "")} aria-hidden="true" />
      <span className="vr-time">{clipLength(phase === "ready" || phase === "sending" ? took.current || ms : ms)}</span>
      <span className="vr-wave" aria-hidden="true">
        {levels.map((l, i) => <i key={i} style={{ height: `${Math.round(12 + l * 88)}%` }} />)}
      </span>
      <span className="vr-note" aria-live="polite">{note}</span>
      <button type="button" className="cp-send ready" title="Send voice message" aria-label="Send voice message"
        disabled={phase === "starting" || phase === "sending"} onClick={send}>{ICON.send}</button>
    </div>
  );
}

// Sounds already fetched this visit (message id → playable address), so
// playing one again doesn't fetch it again; and the one playing now, since
// starting another stops it.
const fetched = new Map<string, string>();
let nowPlaying: HTMLAudioElement | null = null;

// A voice message in a conversation: play/pause, where it's up to (press the
// bar to jump), and 1× / 1.5× / 2×.
export function VoicePlayer({ id, voice, compact }: {
  id: string;
  voice: { ms: number; expired: boolean };
  compact?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [at, setAt] = useState(0);
  const [rate, setRate] = useState(1);
  const [expired, setExpired] = useState(voice.expired);
  const audio = useRef<HTMLAudioElement | null>(null);
  const total = Math.max(voice.ms / 1000, 0.5);

  useEffect(() => () => { audio.current?.pause(); }, []);
  useEffect(() => { if (voice.expired) setExpired(true); }, [voice.expired]);

  // where it's up to, while it plays
  useEffect(() => {
    if (state !== "playing") return;
    let raf = 0;
    const tick = () => {
      if (audio.current) setAt(Math.min(audio.current.currentTime, total));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, total]);

  async function load(): Promise<HTMLAudioElement | null> {
    if (audio.current) return audio.current;
    let url = fetched.get(id);
    if (!url) {
      setState("loading");
      const ws = getActiveWorkspaceId();
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/chat/messages/${id}/voice`, { credentials: "include", headers: ws ? { "X-Workspace-Id": ws } : {} });
      } catch {
        toast.error(NO_ANSWER);
        setState("idle");
        return null;
      }
      if (res.status === 410) { setExpired(true); setState("idle"); return null; }
      if (!res.ok) {
        const b = await res.json().catch(() => ({} as { error?: string }));
        toast.error(typeof b.error === "string" ? b.error : "Couldn't play the voice message.");
        setState("idle");
        return null;
      }
      url = URL.createObjectURL(await res.blob());
      fetched.set(id, url);
      if (fetched.size > 60) {
        const [oldId, oldUrl] = fetched.entries().next().value as [string, string];
        fetched.delete(oldId);
        URL.revokeObjectURL(oldUrl);
      }
    }
    const a = new Audio(url);
    a.preload = "auto";
    a.onplay = () => setState("playing");
    a.onpause = () => setState((s) => (s === "playing" ? "paused" : s));
    a.onended = () => { setState("paused"); setAt(0); };
    // a few times a second even when the page isn't drawing (the bar's
    // smooth movement comes from the animation-frame loop below)
    a.ontimeupdate = () => { if (!a.ended) setAt(Math.min(a.currentTime, total)); };
    audio.current = a;
    return a;
  }

  async function play(from?: number) {
    const a = await load();
    if (!a) return;
    if (from !== undefined) {
      try { a.currentTime = from; } catch { /* not seekable yet: plays from where it is */ }
      setAt(from);
    }
    if (!a.paused) return;
    if (nowPlaying && nowPlaying !== a) nowPlaying.pause();
    nowPlaying = a;
    a.playbackRate = rate;
    try {
      await a.play();
    } catch {
      toast.error("Couldn't play the voice message.");
      setState("idle");
    }
  }
  function toggle() {
    if (state === "loading") return;
    if (state === "playing") audio.current?.pause();
    else play();
  }
  function speed() {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  }

  if (expired) {
    return (
      <div className={"vp expired" + (compact ? " compact" : "")}>
        {ICON.mic}
        <span>Voice message · {clipLength(voice.ms)}</span>
        <span className="vp-gone">expired (voice messages are kept for 30 days)</span>
      </div>
    );
  }
  const pct = Math.min(1, at / total) * 100;
  const started = state === "playing" || state === "paused";
  return (
    <div className={"vp" + (compact ? " compact" : "") + (state === "playing" ? " on" : "")}>
      <button type="button" className="vp-play" onClick={toggle} disabled={state === "loading"}
        aria-label={state === "playing" ? "Pause voice message" : `Play voice message, ${clipLength(voice.ms)}`}
        title={state === "playing" ? "Pause" : "Play"}>
        {state === "loading" ? <span className="vp-spin" aria-hidden="true" /> : state === "playing" ? ICON.pause : ICON.play}
      </button>
      <div
        className="vp-track"
        role="slider"
        tabIndex={0}
        aria-label="Voice message position"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(at)}
        aria-valuetext={`${clipLength(at * 1000)} of ${clipLength(voice.ms)}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          play(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            play(Math.max(0, Math.min(total, at + (e.key === "ArrowRight" ? 5 : -5))));
          }
        }}
      >
        <span className="vp-fill" style={{ width: `${pct}%` }} />
        <span className="vp-knob" style={{ left: `${pct}%` }} />
      </div>
      <span className="vp-time">{started ? `${clipLength(at * 1000)} / ${clipLength(voice.ms)}` : clipLength(voice.ms)}</span>
      <button type="button" className="vp-rate" onClick={speed} title="Playback speed" aria-label={`Playback speed ${rate} times`}>{rate}×</button>
    </div>
  );
}
