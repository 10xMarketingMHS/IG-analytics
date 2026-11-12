// A Material Symbols Rounded icon by name (the font is loaded in index.html),
// as the Pulse Redesign v7 screens use. Decorative unless given a label.
export function Icon({ name, size = 18, fill, className = "", label }: { name: string; size?: number; fill?: boolean; className?: string; label?: string }) {
  return (
    <span className={"msr" + (className ? " " + className : "")} aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined}
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400, 'opsz' 20` }}>
      {name}
    </span>
  );
}
