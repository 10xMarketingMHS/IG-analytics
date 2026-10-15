// A tiny app-wide signal that tasks changed somewhere else — another person
// approved, sent back, moved, held or deleted one. The live notices in the app
// shell fire it; every task list listens and reloads, so a board never sits on a
// stage that's no longer true until the page is changed.
const EVENT = "pulse:tasks-changed";

export function notifyTasksChanged() {
  window.dispatchEvent(new Event(EVENT));
}

export function onTasksChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
