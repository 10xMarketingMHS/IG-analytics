import { useEffect, useState } from "react";
import { useResource } from "@/lib/use-resource";
import type { Taxonomy } from "@/lib/types";

// A Social job's post details, as on Add Post: Content Pillar, Content Type
// (under its pillar), Format (which sets the Post Type) and Audience Avatar,
// from the brand's own lists. A Team Lead or a Manager fills them in when they
// set the job up (editors don't know them); they start the post's details when
// it's scheduled (server/src/post-details.js). Any can be left for later.
export type PostDetails = { pillarId?: string | null; contentTypeId?: string | null; formatId?: string | null; avatarId?: string | null };

export const hasPostDetails = (d: PostDetails | null | undefined) => !!d && Object.values(d).some(Boolean);

// In a task's window: saved as each one is picked (it shows the pick straight
// away, not after the save comes back)
export function PostDetailsSaved({ channelId, saved, canEdit, onSave }: {
  channelId: string;
  saved: PostDetails | null | undefined;
  canEdit: boolean;
  onSave: (next: PostDetails) => void;
}) {
  const key = JSON.stringify(saved ?? {});
  const [v, setV] = useState<PostDetails>(saved ?? {});
  useEffect(() => { setV(JSON.parse(key)); }, [key]);
  return <PostDetailsFields channelId={channelId} value={v} readOnly={!canEdit} onChange={(next) => { setV(next); onSave(next); }} />;
}

export function PostDetailsFields({ channelId, value, onChange, readOnly = false }: {
  channelId: string;
  value: PostDetails;
  onChange?: (next: PostDetails) => void;
  readOnly?: boolean;
}) {
  const { data: tax, loading } = useResource<Taxonomy>(`/taxonomy?channel=${channelId}`);
  const v = value ?? {};
  const set = (patch: PostDetails) => onChange?.({ ...v, ...patch });
  const pillars = (tax?.pillars ?? []).filter((x) => x.active || x.id === v.pillarId);
  const types = (tax?.contentTypes ?? []).filter((x) => x.pillar_id === v.pillarId && (x.active || x.id === v.contentTypeId));
  const formats = (tax?.formats ?? []).filter((x) => x.active || x.id === v.formatId);
  const avatars = (tax?.avatars ?? []).filter((x) => x.active || x.id === v.avatarId);
  const format = formats.find((f) => f.id === v.formatId) ?? null;
  const postType = format ? (format.post_type === "carousel" ? "🖼️ Carousel" : "🎬 Reel") : null;

  if (readOnly) {
    const p = pillars.find((x) => x.id === v.pillarId);
    const ct = types.find((x) => x.id === v.contentTypeId);
    const a = avatars.find((x) => x.id === v.avatarId);
    const rows: [string, string | null][] = [
      ["Content Pillar", p ? `P${p.serial} — ${p.name}` : null],
      ["Content Type", ct ? `T${ct.serial} — ${ct.name}` : null],
      ["Format", format ? `F${format.serial} — ${format.name}` : null],
      ["Post Type", postType],
      ["Audience Avatar", a?.name ?? null],
    ];
    return (
      <dl className="pd-read">
        {rows.map(([k, x]) => (
          <div key={k}><dt>{k}</dt><dd className={x ? "" : "pd-none"}>{x ?? (loading ? "…" : "Not set")}</dd></div>
        ))}
      </dl>
    );
  }

  return (
    <div className="tp2-ngrid pd-grid">
      <label className="tp2-ncell">
        <span>Content Pillar</span>
        <select className="t" value={v.pillarId ?? ""} onChange={(e) => set({ pillarId: e.target.value || null, contentTypeId: null })}>
          <option value="">{loading ? "Loading…" : "Select pillar…"}</option>
          {pillars.map((x) => <option key={x.id} value={x.id}>P{x.serial} — {x.name}</option>)}
        </select>
      </label>
      <label className="tp2-ncell">
        <span>Content Type</span>
        <select className="t" value={v.contentTypeId ?? ""} disabled={!v.pillarId} onChange={(e) => set({ contentTypeId: e.target.value || null })}>
          <option value="">{v.pillarId ? "Select type…" : "Pick a pillar first"}</option>
          {types.map((x) => <option key={x.id} value={x.id}>T{x.serial} — {x.name}</option>)}
        </select>
      </label>
      <label className="tp2-ncell">
        <span>Format</span>
        <select className="t" value={v.formatId ?? ""} onChange={(e) => set({ formatId: e.target.value || null })}>
          <option value="">Select format…</option>
          {formats.map((x) => <option key={x.id} value={x.id}>F{x.serial} — {x.name}</option>)}
        </select>
      </label>
      <div className="tp2-ncell">
        <span>Post Type <small className="pd-faint">· from the format</small></span>
        <div className={"pd-ptype" + (postType ? "" : " pd-none")}>{postType ?? "Pick a format"}</div>
      </div>
      <label className="tp2-ncell">
        <span>Audience Avatar</span>
        <select className="t" value={v.avatarId ?? ""} onChange={(e) => set({ avatarId: e.target.value || null })}>
          <option value="">Select avatar…</option>
          {avatars.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
    </div>
  );
}
