import { audioReady, chatPing } from "@/lib/widget-audio";
import { notifyOn } from "@/lib/notify-prefs";

// Team chat's sound and desktop pop-ups (lib/chat.tsx), as Settings ›
// Notifications sets them, saved on the login:
//   chatSound   a ping for a new message (on unless switched off)
//   chatAll     every message in a conversation you're in (on), or only the
//               ones meant for you: a DM, a mention, a reply in your thread
//   chatDesktop a pop-up on the computer while Echo isn't in front (on, once
//               this browser has allowed Echo's notifications)
// Nothing for a muted conversation (but a mention by name), nor one you're
// looking at with Echo in front. Focus Mode and quiet hours hold them too.
// Echo has to be open (the installed app or a tab, minimized is fine).

export type ChatAlertPrefs = { sound: boolean; all: boolean; desktop: boolean };
export const chatAlertPrefs = (prefs: Record<string, boolean> | undefined | null): ChatAlertPrefs => ({
  sound: notifyOn(prefs, "chatSound"),
  all: notifyOn(prefs, "chatAll"),
  desktop: notifyOn(prefs, "chatDesktop"),
});

// What this browser says about desktop notifications for Echo.
export type DesktopState = "granted" | "denied" | "default" | "unsupported";
export const desktopState = (): DesktopState =>
  typeof window === "undefined" || !("Notification" in window) ? "unsupported" : (Notification.permission as DesktopState);

// Asks this browser to let Echo show desktop pop-ups (only from a click).
export async function askDesktop(): Promise<DesktopState> {
  if (desktopState() === "unsupported") return "unsupported";
  try { return (await Notification.requestPermission()) as DesktopState; } catch { return desktopState(); }
}

// Sound is held back by the browser until the person clicks or types in Echo
// once: get it ready at the first one.
let primed = false;
export function primeChatSound() {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const go = () => {
    audioReady().catch(() => {});
    window.removeEventListener("pointerdown", go);
    window.removeEventListener("keydown", go);
  };
  window.addEventListener("pointerdown", go);
  window.addEventListener("keydown", go);
}

// One ping and one pop-up per message, however many Echo windows are open:
// the first window to get it takes it.
function onceAcrossWindows(key: string, fn: () => void) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) { fn(); return; }
  locks.request(`echo-chat-${key}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    fn();
    await new Promise((r) => setTimeout(r, 6000));
  }).catch(() => fn());
}

export function ringChat({ id, forYou, sound, desktop }: {
  id: string;
  forYou: boolean;
  sound: boolean;
  // the pop-up, when Echo isn't in front
  desktop: { title: string; body: string; tag: string; icon?: string | null; onOpen: () => void } | null;
}) {
  onceAcrossWindows(id, () => {
    if (sound) chatPing(forYou);
    if (desktop && desktopState() === "granted") {
      try {
        // silent: the ping above is the sound (or none, when it's switched off)
        const n = new Notification(desktop.title, { body: desktop.body, tag: desktop.tag, icon: desktop.icon || "/app-icon.svg", silent: true });
        n.onclick = () => { window.focus(); desktop.onOpen(); n.close(); };
      } catch { /* this browser won't show one */ }
    }
  });
}
