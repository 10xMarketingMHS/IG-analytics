import { useEffect, useRef, useState } from "react";

export type Opt = { value: string; label: string; count?: number };

// A compact multi-select dropdown: a labelled button that opens a checkbox
// menu. Closes on outside click. Selecting multiple options is OR within it.
// Self-contained — driven entirely by its props (styling lives in .msel-* CSS).
export function MultiSelect({ label, options, selected, onToggle }: {
  label: string; options: Opt[]; selected: Set<string>; onToggle: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const n = selected.size;
  return (
    <div className="msel" ref={ref}>
      <button className={"msel-btn" + (n ? " on" : "")} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        {n > 0 && <span className="msel-count">{n}</span>}
        <span className="msel-cv">▾</span>
      </button>
      {open && (
        <div className="msel-menu">
          {options.length === 0 ? (
            <div className="msel-empty">No options</div>
          ) : options.map((o) => (
            <label key={o.value} className={"msel-opt" + (selected.has(o.value) ? " sel" : "")}>
              <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(o.value)} />
              <span className="msel-opt-l">{o.label}</span>
              {o.count !== undefined && <span className="msel-opt-n">{o.count}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
