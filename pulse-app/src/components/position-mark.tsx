import { Crown, Film, Shield, Sprout, Star, type LucideIcon } from "lucide-react";

// A person's position as a small mark after their name (their Position on
// Team › Roster): Manager a crown, Asst. Manager a shield, Team Lead a star,
// Senior Editor a film, Junior Editor a sprout. Any other position shows
// none. Hovering says it in words.
const MARKS: Record<string, LucideIcon> = {
  manager: Crown,
  "asst. manager": Shield,
  "assistant manager": Shield,
  "team lead": Star,
  "senior editor": Film,
  "junior editor": Sprout,
};

export function PositionMark({ designation, size = 14 }: { designation?: string | null; size?: number }) {
  const label = designation?.trim();
  const Icon = label ? MARKS[label.toLowerCase()] : undefined;
  if (!Icon) return null;
  return (
    <span className="pos-mark" role="img" aria-label={label} title={label}>
      <Icon size={size} strokeWidth={2} aria-hidden />
    </span>
  );
}
