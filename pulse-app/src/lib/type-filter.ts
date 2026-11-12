import type { ContentFormatDef } from "@/lib/types";

// A Type filter over a list of tasks (Pipeline, Scheduling): the types in the
// list, each main type once (Carousel) with its sub-types in the list after it
// (Video Carousel). Picking a main type picks its sub-types too.
type Typed = { content_format_id: string | null; content_format_name: string | null };
export type TypeOption = { id: string; name: string; subs: { id: string; name: string }[] };

export function typeOptions(tasks: Typed[], formats: ContentFormatDef[] | null | undefined): TypeOption[] {
  const byId = new Map((formats ?? []).map((f) => [f.id, f]));
  const mains = new Map<string, { id: string; name: string; subs: Map<string, string> }>();
  for (const t of tasks) {
    if (!t.content_format_id) continue;
    const main = byId.get(t.content_format_id)?.parent_id ?? null;
    const mainId = main ?? t.content_format_id;
    const m = mains.get(mainId) ?? { id: mainId, name: (main ? byId.get(main)?.name : t.content_format_name) ?? byId.get(mainId)?.name ?? "—", subs: new Map() };
    if (main) m.subs.set(t.content_format_id, t.content_format_name ?? byId.get(t.content_format_id)?.name ?? "—");
    mains.set(mainId, m);
  }
  return [...mains.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ id: m.id, name: m.name, subs: [...m.subs].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) }));
}

// the pick, if it's still in the list (else "": everything)
export const typePickIn = (pick: string, options: TypeOption[]) =>
  pick && options.some((m) => m.id === pick || m.subs.some((s) => s.id === pick)) ? pick : "";

// does a task match the pick: its own type, or its main type
export function matchesType(t: Typed, pick: string, formats: ContentFormatDef[] | null | undefined) {
  if (!pick) return true;
  if (t.content_format_id === pick) return true;
  return !!t.content_format_id && (formats ?? []).find((f) => f.id === t.content_format_id)?.parent_id === pick;
}
