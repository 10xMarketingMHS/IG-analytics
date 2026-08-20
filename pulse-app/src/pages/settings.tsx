import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { UserManagement } from "@/components/user-management";
import { EditorModal } from "@/pages/editor-modal";
import type { Editor } from "@/lib/types";

const REEL_WEIGHTS: [string, number][] = [
  ["Views", 20], ["Like rate", 15], ["Comment rate", 25], ["Share rate", 25], ["Save rate", 15],
];
const CAROUSEL_WEIGHTS: [string, number][] = [
  ["Views", 10], ["Like rate", 10], ["Comment rate", 20], ["Share rate", 30], ["Save rate", 30],
];

export function SettingsPage() {
  const { taxonomy, loading, refetch } = useTaxonomy();
  const { editors, refetch: refetchEditors } = useEditors();
  const { isAdmin } = useWorkspaces();
  const [pillarId, setPillarId] = useState("");
  // null = closed; { editor: null } = create; { editor } = edit
  const [editorModal, setEditorModal] = useState<{ editor: Editor | null } | null>(null);

  async function add(path: string, body: object, label: string) {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await refetch();
      toast.success(`${label} added.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add.");
    }
  }

  async function remove(path: string, name: string, label: string) {
    if (!window.confirm(`Delete ${label.toLowerCase()} "${name}"?`)) return;
    try {
      await api(path, { method: "DELETE" });
      await refetch();
      toast.success(`${label} deleted.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete.");
    }
  }

  async function removeEditor(ed: Editor) {
    if (!window.confirm(`Remove editor "${ed.name}"? Their posts stay but become unassigned.`)) return;
    try {
      await api(`/editors/${ed.id}`, { method: "DELETE" });
      await refetchEditors();
      toast.success("Editor removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove editor.");
    }
  }

  function addPillar() {
    const name = window.prompt("New pillar name")?.trim();
    if (name) add("/pillars", { name }, "Pillar");
  }
  function addAvatar() {
    const name = window.prompt("New avatar name")?.trim();
    if (name) add("/avatars", { name }, "Avatar");
  }
  function addContentType() {
    if (!pillarId) return;
    const name = window.prompt("New content type name")?.trim();
    if (name) add("/content-types", { name, pillarId }, "Content type");
  }
  function addFormat() {
    // Format is channel-wide now — no pillar.
    const name = window.prompt("New format name")?.trim();
    if (!name) return;
    const pt = window.prompt("Post type — type 'reel' or 'carousel'", "reel")?.trim();
    if (pt !== "reel" && pt !== "carousel") {
      toast.error("Post type must be 'reel' or 'carousel'.");
      return;
    }
    add("/formats", { name, postType: pt }, "Format");
  }

  if (loading || !taxonomy) {
    return <section className="screen"><div className="hint">Loading…</div></section>;
  }

  const activePillar = pillarId || taxonomy.pillars[0]?.id || "";
  const cts = taxonomy.contentTypes.filter((c) => c.pillar_id === activePillar);

  return (
    <section className="screen">
      <div className="sectitle"><span className="dot" />Content taxonomy<span className="s">Pillars &amp; Types nest (P#/T#); Formats are channel-wide (F#)</span></div>
      <div className="card pad">
        <label className="f">Content Pillars</label>
        <div className="taxrow">
          {taxonomy.pillars.map((p) => (
            <span className="taxchip" key={p.id}>
              <span className="taxserial">P{p.serial}</span>{p.name}
              {isAdmin && (
                <span className="x" title="Delete pillar" onClick={() => remove(`/pillars/${p.id}`, p.name, "Pillar")}>×</span>
              )}
            </span>
          ))}
          {isAdmin && <button className="addchip" onClick={addPillar}>＋ Add</button>}
        </div>

        <label className="f" style={{ marginTop: 14 }}>Audience Avatars</label>
        <div className="taxrow">
          {taxonomy.avatars.map((a) => (
            <span className="taxchip" key={a.id}>
              {a.name}
              {isAdmin && (
                <span className="x" title="Delete avatar" onClick={() => remove(`/avatars/${a.id}`, a.name, "Avatar")}>×</span>
              )}
            </span>
          ))}
          {isAdmin && <button className="addchip" onClick={addAvatar}>＋ Add</button>}
        </div>

        <label className="f" style={{ marginTop: 18 }}>Content Types — per pillar</label>
        <select className="t" style={{ maxWidth: 340, marginBottom: 12 }} value={activePillar} onChange={(e) => setPillarId(e.target.value)}>
          {taxonomy.pillars.map((p) => (
            <option key={p.id} value={p.id}>P{p.serial} — {p.name}</option>
          ))}
        </select>
        <div className="taxrow">
          {cts.map((c) => (
            <span className="taxchip" key={c.id}>
              <span className="taxserial">T{c.serial}</span>{c.name}
              {isAdmin && (
                <span className="x" title="Delete content type" onClick={() => remove(`/content-types/${c.id}`, c.name, "Content type")}>×</span>
              )}
            </span>
          ))}
          {isAdmin && <button className="addchip" onClick={addContentType}>＋ Add</button>}
        </div>

        <label className="f" style={{ marginTop: 18 }}>Formats — channel-wide (fully selectable on every pillar)</label>
        <div className="taxrow">
          {taxonomy.formats.map((f) => (
            <span className="taxchip" key={f.id}>
              <span className="taxserial">F{f.serial}</span>{f.name}
              <span className={"ptbadge " + (f.post_type === "reel" ? "pt-reel" : "pt-car")} style={{ fontSize: 10 }}>{f.post_type}</span>
              {isAdmin && (
                <span className="x" title="Delete format" onClick={() => remove(`/formats/${f.id}`, f.name, "Format")}>×</span>
              )}
            </span>
          ))}
          {isAdmin && <button className="addchip" onClick={addFormat}>＋ Add</button>}
        </div>

        <div className="hint" style={{ marginTop: 12 }}>
          {isAdmin
            ? "Pillars (P#) and their Content Types (T#) nest; Formats (F#) are shared across the whole channel. Numbers are permanent — deleting one won't renumber the rest. Deleting an item still used by posts is blocked — reassign those posts first."
            : "Only admins can add or remove taxonomy items."}
        </div>
      </div>

      <div className="sectitle"><span className="dot" />Editors<span className="s">assignable to posts · ranked on the Leaderboard</span></div>
      <div className="card pad">
        <div className="taxrow">
          {(editors ?? []).map((ed) => (
            <span className="taxchip" key={ed.id}>
              {ed.image_url ? (
                <img
                  src={ed.image_url}
                  alt=""
                  style={{ width: 22, height: 22, borderRadius: 6, objectFit: "cover" }}
                />
              ) : (
                <span
                  style={{
                    width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center",
                    background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff",
                    fontSize: 11, fontWeight: 800,
                  }}
                >
                  {ed.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span
                style={{ cursor: isAdmin ? "pointer" : "default" }}
                onClick={() => isAdmin && setEditorModal({ editor: ed })}
                title={isAdmin ? "Edit editor" : undefined}
              >
                {ed.name}
              </span>
              {ed.designation && (
                <span className="ptbadge pt-reel" style={{ fontSize: 10 }}>{ed.designation}</span>
              )}
              {isAdmin && (
                <span className="x" title="Remove editor" onClick={() => removeEditor(ed)}>×</span>
              )}
            </span>
          ))}
          {isAdmin && (
            <button className="addchip" onClick={() => setEditorModal({ editor: null })}>＋ Add editor</button>
          )}
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          Add your editing team with a photo &amp; designation (Video Editor, Motion Designer, Graphic
          Designer…). Click an editor to edit. Assign one to each post on the Add Post screen.
        </div>
      </div>

      <div className="sectitle"><span className="dot" />Scoring weights<span className="s">how the performance score is calculated</span></div>
      <div className="grid g2">
        <div className="card pad">
          <b style={{ fontSize: 13 }}>Reels</b>
          <div style={{ marginTop: 12 }}>
            {REEL_WEIGHTS.map(([nm, w]) => (
              <div className="weightrow" key={nm}>
                <span className="nm">{nm}</span>
                <span className="bar"><i style={{ width: `${w}%` }} /></span>
                <span className="wv">{w}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card pad">
          <b style={{ fontSize: 13 }}>Carousels</b>
          <div style={{ marginTop: 12 }}>
            {CAROUSEL_WEIGHTS.map(([nm, w]) => (
              <div className="weightrow" key={nm}>
                <span className="nm">{nm}</span>
                <span className="bar"><i style={{ width: `${w}%` }} /></span>
                <span className="wv">{w}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="sectitle"><span className="dot" />Integrations<span className="s">connect your data sources</span></div>
      <div className="grid g2">
        <div className="card pad" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div className="ig-badge" style={{ width: 44, height: 44, fontSize: 20, margin: 0, borderRadius: 12 }}>📸</div>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 13.5 }}>Instagram</b>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Not connected · Phase 2</div>
          </div>
          <button className="btn" disabled>Connect</button>
        </div>
        <div className="card pad" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#0f9d58", display: "grid", placeItems: "center", fontSize: 20 }}>📗</div>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 13.5 }}>Google Sheet</b>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Import your old tracker</div>
          </div>
          <button className="btn" disabled>Import data</button>
        </div>
      </div>

      <UserManagement />

      {editorModal && (
        <EditorModal
          editor={editorModal.editor}
          onClose={() => setEditorModal(null)}
          onSaved={refetchEditors}
        />
      )}
    </section>
  );
}
