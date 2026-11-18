import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useBreakState } from "@/lib/break-context";
import { popup, setQuiet } from "@/lib/quiet-popups";
import { audioReady, chimeAt, playSound, setSoundVolume, stopSound, type SoundKind } from "@/lib/widget-audio";

// Widgets (the sidebar's last item, pages/widgets.tsx): small helpers each person
// picks for themselves. What they keep follows them from device to device
// (server/src/routes/widgets.js; before the database has its table, this browser
// keeps it). What's running — a timer, Focus Mode — stays in this browser, and shows
// in the bottom bar (components/widget-bar.tsx) while it runs.
// Nothing here touches task timers or the day's break time.

export type WidgetKey = "water" | "stretch" | "chime" | "note" | "sounds" | "game";
export const WIDGETS: { key: WidgetKey; icon: string; name: string; blurb: string }[] = [
  { key: "water", icon: "💧", name: "Drink water", blurb: "Tap a glass and keep count today. A reminder if you want one." },
  { key: "stretch", icon: "🧘", name: "Stretch", blurb: "One guided minute for your neck, back and wrists." },
  { key: "chime", icon: "⏰", name: "Chime me back", blurb: "A sound after the minutes you pick." },
  { key: "note", icon: "📝", name: "Quick note", blurb: "Jot it down now. It shows when you're back from your break." },
  { key: "sounds", icon: "🎧", name: "Relax sounds", blurb: "Rain, waves or soft noise while you rest or work." },
  { key: "game", icon: "🧠", name: "Memory game", blurb: "A short round of matching cards." },
];

type Water = { day: string; count: number; target: number; remindMins: number };
type PomoSettings = { focus: number; short: number; long: number; linkFocus: boolean; day: string; done: number };
type Saved = { picks: WidgetKey[]; water: Water; note: string; pomodoro: PomoSettings };
const DEFAULTS: Saved = {
  picks: [],
  water: { day: "", count: 0, target: 8, remindMins: 0 },
  note: "",
  pomodoro: { focus: 25, short: 5, long: 15, linkFocus: true, day: "", done: 0 },
};

export type PomoPhase = "focus" | "short" | "long";
export type Pomo = { phase: PomoPhase; total: number; endAt: number | null; left: number; ended?: boolean; byBreak?: boolean };
type Live = { pomo: Pomo | null; focusBy: "me" | "pomodoro" | null; chime: { endAt: number; total: number } | null; sipAt: number };
const NO_LIVE: Live = { pomo: null, focusBy: null, chime: null, sipAt: 0 };

// A focus round's break: long after every fourth one.
const LONG_EVERY = 4;
export const PHASE_NAME: Record<PomoPhase, string> = { focus: "Focus", short: "Short break", long: "Long break" };

const istDay = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
function read<T>(key: string): T | null {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function write(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* fine, just not remembered */ }
}
const mergeSaved = (s: Partial<Saved> | null): Saved => ({
  picks: s?.picks ?? DEFAULTS.picks,
  water: { ...DEFAULTS.water, ...s?.water },
  note: s?.note ?? "",
  pomodoro: { ...DEFAULTS.pomodoro, ...s?.pomodoro },
});
const toServer = (s: Saved) => ({ picks: s.picks, data: { water: s.water, note: s.note, pomodoro: s.pomodoro } });

type Ctx = {
  now: number;
  picks: WidgetKey[];
  togglePick: (k: WidgetKey) => void;
  water: Water;
  setWater: (patch: Partial<Water>) => void;
  addGlass: (by?: number) => void;
  note: string;
  setNote: (s: string) => void;
  pomoSettings: PomoSettings;
  setPomoSettings: (patch: Partial<PomoSettings>) => void;
  pomo: Pomo | null;
  pomoLeft: number;
  pomoNext: PomoPhase;
  pomoStart: (phase: PomoPhase) => void;
  pomoPause: () => void;
  pomoResume: () => void;
  pomoStop: () => void;
  focusOn: boolean;
  setFocus: (on: boolean) => void;
  chime: { endAt: number; total: number } | null;
  chimeStart: (mins: number) => void;
  chimeCancel: () => void;
  sound: { kind: SoundKind; volume: number } | null;
  soundPlay: (kind: SoundKind) => void;
  soundStop: () => void;
  soundVolume: (v: number) => void;
};
const WidgetsCtx = createContext<Ctx | null>(null);

export function useWidgets(): Ctx {
  const v = useContext(WidgetsCtx);
  if (!v) throw new Error("useWidgets must be used within a WidgetsProvider");
  return v;
}

export function WidgetsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.id ?? "anon";
  const savedKey = `echo-widgets-${uid}`, liveKey = `echo-widgets-live-${uid}`;
  const [saved, setSaved] = useState<Saved>(() => mergeSaved(read<Saved>(savedKey)));
  const [live, setLiveRaw] = useState<Live>(() => read<Live>(liveKey) ?? NO_LIVE);
  const [sound, setSound] = useState<{ kind: SoundKind; volume: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const setLive = (fn: (l: Live) => Live) => setLiveRaw((l) => { const n = fn(l); write(liveKey, n); return n; });

  // ---- what they keep: on the server when it has the table, and always in this browser ----
  const serverOn = useRef(false);
  const lastSent = useRef("");
  useEffect(() => {
    let on = true;
    api<{ ready: boolean; picks?: WidgetKey[]; data?: Partial<Saved>; updatedAt?: string | null }>("/widgets/me")
      .then((r) => {
        if (!on) return;
        serverOn.current = !!r.ready;
        if (r.ready && r.updatedAt) {
          const s = mergeSaved({ ...r.data, picks: r.picks });
          lastSent.current = JSON.stringify(toServer(s));
          setSaved(s);
        }
      })
      .catch(() => { /* this browser's copy will do */ });
    return () => { on = false; };
  }, []);
  useEffect(() => {
    write(savedKey, saved);
    const body = JSON.stringify(toServer(saved));
    if (!serverOn.current || body === lastSent.current) return;
    const t = setTimeout(() => {
      lastSent.current = body;
      api("/widgets/me", { method: "PUT", body }).catch(() => { lastSent.current = ""; });
    }, 600);
    return () => clearTimeout(t);
  }, [saved, savedKey]);

  // another tab of this browser changed something
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === liveKey) setLiveRaw(read<Live>(liveKey) ?? NO_LIVE);
      if (e.key === savedKey) setSaved(mergeSaved(read<Saved>(savedKey)));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [liveKey, savedKey]);
  // one tab says when a timer ends
  const once = (id: string) => {
    const k = `${liveKey}-rang-${id.split(":")[0]}`;
    if (read<string>(k) === id) return false;
    write(k, id);
    return true;
  };

  // ---- the clock, only while something's counting down ----
  const running = !!(live.pomo?.endAt || live.chime);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const pomoRung = useRef(false), chimeRung = useRef(false);
  useAlarm(live.pomo?.endAt ?? null, pomoRung);
  useAlarm(live.chime?.endAt ?? null, chimeRung);

  const today = istDay();
  const water: Water = saved.water.day === today ? saved.water : { ...saved.water, day: today, count: 0 };
  const pomoSettings: PomoSettings = saved.pomodoro.day === today ? saved.pomodoro : { ...saved.pomodoro, day: today, done: 0 };
  const breakAfter = (done: number): PomoPhase => (done > 0 && done % LONG_EVERY === 0 ? "long" : "short");

  useEffect(() => {
    const p = live.pomo;
    if (p?.endAt && now >= p.endAt) {
      if (!pomoRung.current) chimeAt();
      if (once(`pomo:${p.endAt}`)) {
        if (p.phase === "focus") {
          const done = pomoSettings.done + 1;
          setSaved((s) => ({ ...s, pomodoro: { ...pomoSettings, done } }));
          const next = breakAfter(done);
          toast.success(`Focus done. Time for a ${minsOf(next)}-minute break.`);
        } else {
          toast.success("Break over. Ready to focus again?");
        }
      }
      setLive((l) => ({ ...l, pomo: { ...p, endAt: null, left: 0, ended: true }, focusBy: l.focusBy === "pomodoro" ? null : l.focusBy }));
    }
    const c = live.chime;
    if (c && now >= c.endAt) {
      if (!chimeRung.current) chimeAt();
      if (once(`chime:${c.endAt}`)) toast("⏰ Time's up", { duration: 12_000 });
      setLive((l) => ({ ...l, chime: null }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  const minsOf = (phase: PomoPhase) => pomoSettings[phase];

  // ---- Focus Mode ----
  useEffect(() => {
    const waited = setQuiet(!!live.focusBy);
    if (waited > 0) toast(`${waited} pop-up${waited === 1 ? "" : "s"} waited while you were focusing. See the bell and your Inbox.`);
  }, [live.focusBy]);
  useEffect(() => () => { setQuiet(false); stopSound(); }, []);

  // ---- a water reminder, for whoever asked for one ----
  const addGlass = (by = 1) => {
    setSaved((s) => {
      const w = s.water.day === today ? s.water : { ...s.water, day: today, count: 0 };
      return { ...s, water: { ...w, count: Math.max(0, Math.min(99, w.count + by)) } };
    });
    if (by > 0) setLive((l) => ({ ...l, sipAt: Date.now() }));
  };
  useEffect(() => {
    const mins = water.remindMins;
    if (!mins) return;
    const every = mins * 60_000;
    const check = () => {
      const t = Date.now();
      if (t - live.sipAt < every) return;
      setLive((l) => ({ ...l, sipAt: t }));
      if (!once(`water:${Math.floor(t / every)}`)) return;
      popup(() => {
        chimeAt();
        toast("💧 Time for some water", { duration: 15_000, action: { label: "Drank a glass", onClick: () => addGlass() } });
      });
    };
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [water.remindMins, live.sipAt]);

  // ---- a break: a focus round waits for it, and your note is there when you're back ----
  const onBreak = !!useBreakState().status?.onBreak;
  const wasOnBreak = useRef(onBreak);
  useEffect(() => {
    if (onBreak === wasOnBreak.current) return;
    wasOnBreak.current = onBreak;
    if (onBreak) {
      setLive((l) => (l.pomo?.endAt && l.pomo.phase === "focus"
        ? { ...l, pomo: { ...l.pomo, endAt: null, left: l.pomo.endAt - Date.now(), byBreak: true } } : l));
      return;
    }
    setLive((l) => (l.pomo?.byBreak
      ? { ...l, pomo: { ...l.pomo, endAt: Date.now() + l.pomo.left, byBreak: false } } : l));
    if (saved.note.trim()) toast("📝 Your note", { description: saved.note.trim().slice(0, 240), duration: 12_000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBreak]);

  const value: Ctx = {
    now,
    picks: saved.picks,
    togglePick: (k) => setSaved((s) => ({ ...s, picks: s.picks.includes(k) ? s.picks.filter((x) => x !== k) : [...s.picks, k] })),
    water,
    setWater: (patch) => {
      setSaved((s) => ({ ...s, water: { ...water, ...patch } }));
      // the first reminder comes a full wait after asking for it
      if (patch.remindMins) setLive((l) => ({ ...l, sipAt: Date.now() }));
    },
    addGlass,
    note: saved.note,
    setNote: (note) => setSaved((s) => ({ ...s, note })),
    pomoSettings,
    setPomoSettings: (patch) => setSaved((s) => ({ ...s, pomodoro: { ...pomoSettings, ...patch } })),
    pomo: live.pomo,
    pomoLeft: live.pomo ? (live.pomo.endAt ? live.pomo.endAt - now : live.pomo.left) : 0,
    pomoNext: live.pomo?.ended && live.pomo.phase === "focus" ? breakAfter(pomoSettings.done) : "focus",
    pomoStart: (phase) => {
      audioReady().catch(() => {});
      const total = minsOf(phase) * 60_000;
      const t = Date.now();
      setNow(t);
      setLive((l) => ({
        ...l,
        pomo: { phase, total, endAt: t + total, left: total },
        focusBy: phase === "focus"
          ? (l.focusBy ?? (pomoSettings.linkFocus ? "pomodoro" : null))
          : (l.focusBy === "pomodoro" ? null : l.focusBy),
      }));
    },
    pomoPause: () => setLive((l) => (l.pomo?.endAt ? { ...l, pomo: { ...l.pomo, endAt: null, left: l.pomo.endAt - Date.now(), byBreak: false } } : l)),
    pomoResume: () => {
      audioReady().catch(() => {});
      const t = Date.now();
      setNow(t);
      setLive((l) => (l.pomo && !l.pomo.endAt && !l.pomo.ended ? { ...l, pomo: { ...l.pomo, endAt: t + l.pomo.left, byBreak: false } } : l));
    },
    pomoStop: () => setLive((l) => ({ ...l, pomo: null, focusBy: l.focusBy === "pomodoro" ? null : l.focusBy })),
    focusOn: !!live.focusBy,
    setFocus: (on) => setLive((l) => ({ ...l, focusBy: on ? "me" : null })),
    chime: live.chime,
    chimeStart: (mins) => {
      audioReady().catch(() => {});
      const t = Date.now();
      setNow(t);
      setLive((l) => ({ ...l, chime: { endAt: t + mins * 60_000, total: mins * 60_000 } }));
    },
    chimeCancel: () => setLive((l) => ({ ...l, chime: null })),
    sound,
    soundPlay: (kind) => {
      const volume = sound?.volume ?? 0.5;
      playSound(kind, volume);
      setSound({ kind, volume });
    },
    soundStop: () => { stopSound(); setSound(null); },
    soundVolume: (volume) => { setSoundVolume(volume); setSound((s) => (s ? { ...s, volume } : s)); },
  };
  return <WidgetsCtx.Provider value={value}>{children}</WidgetsCtx.Provider>;
}

// Books the chime for when a timer ends, once sound is allowed.
function useAlarm(endAt: number | null, booked: { current: boolean }) {
  useEffect(() => {
    booked.current = false;
    if (!endAt) return;
    let off = false;
    let cancel = () => {};
    audioReady().then(() => {
      const secs = (endAt - Date.now()) / 1000;
      if (off || secs <= 0) return;
      cancel = chimeAt(secs);
      booked.current = true;
    }).catch(() => {});
    return () => { off = true; cancel(); };
  }, [endAt, booked]);
}
