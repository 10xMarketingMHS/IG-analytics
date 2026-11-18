// Runs `fn` every `ms` while this tab is in view. A hidden tab (another tab in
// front, the window minimised, the computer asleep) asks the server nothing;
// coming back after at least `ms` away runs it once straight away. The caller
// does its own first load. Returns the stop function.
export function whileVisible(fn: () => void, ms: number): () => void {
  let last = Date.now();
  const tick = () => {
    if (document.hidden) return;
    last = Date.now();
    fn();
  };
  const id = window.setInterval(tick, ms);
  const onVisible = () => { if (!document.hidden && Date.now() - last >= ms) tick(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
