import { Link } from "react-router-dom";
import { SECTIONS, type SectionKey, type SectionTab } from "@/lib/sections";
import "./section-tabs.css";

// The tabs across the top of Social's and Ads' pages (lib/sections.ts): only
// those the person may open, the open one lit, each with its count where it has
// one (Posts: how many; Uploads: how many wait).
export function SectionTabs({ section, current, canSee, counts }: {
  section: SectionKey;
  current: string;
  canSee: (t: SectionTab) => boolean;
  counts?: Partial<Record<string, number | null | undefined>>;
}) {
  const tabs = SECTIONS[section].tabs.filter(canSee);
  if (tabs.length < 2) return null;
  return (
    <nav className="sectabs" aria-label={SECTIONS[section].title}>
      {tabs.map((t) => (
        <Link key={t.key} to={t.to} className={"sectab" + (t.key === current ? " on" : "")} aria-current={t.key === current ? "page" : undefined}>
          {t.label}
          {counts?.[t.key] ? <span className="sectab-n">{counts[t.key]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
