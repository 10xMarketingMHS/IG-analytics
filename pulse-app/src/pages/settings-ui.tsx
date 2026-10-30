import type { ReactNode } from "react";

// The small pieces every Settings section is built from (Pulse Redesign v5):
// line icons, a switch, a − value + stepper and a segmented picker. Styles in
// settings.css.

export const sv = (d: ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export const SI = {
  tune: sv(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>),
  hub: sv(<><circle cx="12" cy="12" r="2.5" /><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="m6.5 6.5 3.7 3.7M17.5 6.5l-3.7 3.7M6.5 17.5l3.7-3.7M17.5 17.5l-3.7-3.7" /></>),
  category: sv(<><path d="m12 3 4 7H8z" /><circle cx="17" cy="17" r="3.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /></>),
  timer: sv(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9.5 2.5h5" /></>),
  chart: sv(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>),
  admin: sv(<><path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6z" /><circle cx="12" cy="10.5" r="2.5" /><path d="M8.5 16a4 4 0 0 1 7 0" /></>),
  clock: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  bell: sv(<><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  shield: sv(<><path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></>, 15),
  lock: sv(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 16),
  lockSm: sv(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 13),
  trash: sv(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>, 16),
  plus: sv(<path d="M12 5v14M5 12h14" />, 15),
  minus: sv(<path d="M5 12h14" />, 15),
  check: sv(<path d="M20 6 9 17l-5-5" />, 14),
  checkCircle: sv(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-5" /></>, 15),
  error: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>, 15),
  info: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>, 15),
  arrow: sv(<path d="M5 12h14M13 6l6 6-6 6" />, 14),
  warning: sv(<><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17v.5" /></>, 13),
  sync: sv(<><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>, 15),
  link: sv(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>, 15),
  unlink: sv(<><path d="M15.7 14 18.7 11a4 4 0 0 0-5.7-5.7L12 6.3M8.3 10 5.3 13a4 4 0 0 0 5.7 5.7l1-1" /><path d="M4 4l16 16" /></>, 15),
  megaphone: sv(<><path d="M3 10v4h3l7 4V6L6 10z" /><path d="M17 9a4 4 0 0 1 0 6" /></>, 16),
  card: sv(<><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></>, 16),
  folder: sv(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, 16),
  headset: sv(<><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /></>, 16),
  addTask: sv(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5L16 9.5" /></>, 14),
  flag: sv(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>, 14),
  groups: sv(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6a6.5 6.5 0 0 1 3.5 5.4" /></>, 14),
  stopwatch: sv(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4M9.5 2.5h5" /></>, 14),
  edit: sv(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, 14),
};

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled}
      className={"st-tog" + (on ? " on" : "")} onClick={() => onChange(!on)} />
  );
}

export function Stepper({ value, onDec, onInc, decDisabled, incDisabled, label, className = "" }: {
  value: ReactNode; onDec: () => void; onInc: () => void; decDisabled?: boolean; incDisabled?: boolean; label: string; className?: string;
}) {
  return (
    <span className={"st-step " + className}>
      <button type="button" onClick={onDec} disabled={decDisabled} aria-label={`Less ${label}`}>{SI.minus}</button>
      <b aria-live="polite">{value}</b>
      <button type="button" onClick={onInc} disabled={incDisabled} aria-label={`More ${label}`}>{SI.plus}</button>
    </span>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="st-seg" role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={k} type="button" className={value === k ? "on" : ""} aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

// "1h 30m" from hours; "30m" under an hour; "0h" for nothing.
export function fmtHours(h: number) {
  const total = Math.round(h * 60);
  const hh = Math.floor(Math.abs(total) / 60), mm = Math.abs(total) % 60;
  const s = (hh ? `${hh}h` : "") + (mm ? `${hh ? " " : ""}${mm}m` : "");
  return (total < 0 ? "−" : "") + (s || "0h");
}

// A section someone may look at but not change (Settings › Page access: See
// without Change): shown as it is, every control in it off.
export function LookOnly({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <fieldset disabled className="st-lookonly">
      <span className="st-note">{SI.lock}You can look at this. Changing it is for the positions Page access lets.</span>
      {children}
    </fieldset>
  );
}
