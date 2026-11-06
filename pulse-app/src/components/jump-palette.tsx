import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

export type JumpItem = { title: string; href: string; icon: ReactNode; group: string; state?: unknown };

// Search or jump to… (Ctrl/⌘ K): type part of a page's name, Enter opens it.
// Only lists what the sidebar already offers this person.
export function JumpPalette({ items, onClose }: { items: JumpItem[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => i.title.toLowerCase().includes(s) || i.group.toLowerCase().includes(s)) : items;
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function go(item: JumpItem | undefined) {
    if (!item) return;
    onClose();
    navigate(item.href, item.state ? { state: item.state } : undefined);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(shown[active]); }
  }

  let lastGroup = "";
  return createPortal(
    <div className="jp-scrim" onClick={onClose}>
      <div className="jp" role="dialog" aria-label="Search or jump to" onClick={(e) => e.stopPropagation()}>
        <div className="jp-head">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search pages…" aria-label="Search pages" />
          <kbd>esc</kbd>
        </div>
        <div className="jp-list" ref={listRef}>
          {shown.length === 0 && <div className="jp-empty">Nothing matches “{q.trim()}”.</div>}
          {shown.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.group + item.href + item.title}>
                {head && <div className="jp-group">{head}</div>}
                <button type="button" data-i={i} className={"jp-item" + (i === active ? " on" : "")}
                  onMouseEnter={() => setActive(i)} onClick={() => go(item)}>
                  <span className="jp-ic">{item.icon}</span>{item.title}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
