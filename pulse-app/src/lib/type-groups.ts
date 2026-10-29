import { useCallback, useState } from "react";

// Sub-types (Settings › Tasks & time): a task type may sit under a main type of
// the same category, as Video Carousel and Image Carousel under Carousel. Each is
// still its own type, with its own points, time and goals, and the main type is a
// type too; lists show the main type and fold its sub-types under it. One level
// only (server/src/routes/content-formats.js).
export type TypeGroup<T> = { main: T; subs: T[] };

// A list of types as main types, each with its sub-types after it, keeping the
// list's order. A sub-type whose main type isn't in the list stays on its own.
export function groupTypes<T>(rows: T[], idOf: (r: T) => string, parentOf: (id: string) => string | null | undefined): TypeGroup<T>[] {
  const ids = new Set(rows.map(idOf));
  const under = (r: T) => { const p = parentOf(idOf(r)); return p && p !== idOf(r) && ids.has(p) ? p : null; };
  const groups = new Map<string, TypeGroup<T>>();
  const out: TypeGroup<T>[] = [];
  for (const r of rows) {
    if (under(r)) continue;
    const g = { main: r, subs: [] as T[] };
    groups.set(idOf(r), g);
    out.push(g);
  }
  for (const r of rows) {
    const p = under(r);
    if (!p) continue;
    const g = groups.get(p);
    if (g) g.subs.push(r);
    else out.push({ main: r, subs: [] });
  }
  return out;
}

// Which main types are open, showing their sub-types; all folded to start.
export function useFolds() {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const isOpen = useCallback((id: string) => open.has(id), [open]);
  const toggle = useCallback((id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  }), []);
  const show = useCallback((id: string) => setOpen((s) => (s.has(id) ? s : new Set(s).add(id))), []);
  return { isOpen, toggle, show };
}

export const kindsWord = (n: number) => `${n} sub-type${n === 1 ? "" : "s"}`;
