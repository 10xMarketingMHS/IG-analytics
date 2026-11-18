import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { RichText, RICH_TEXT_HELP } from "@/lib/rich-text";
import "./pipeline.css";
import "./knowledge.css";

// Knowledge Hub (server/src/routes/knowledge.js): the team's SOPs, brand
// guidelines and training. Shelves across the top, a card for each page;
// ?item=<id> opens one (a link that can be shared), ?item=new writes one.
// Everyone reads; the Managers and Team Leads (or whoever Page access lets)
// add, edit, pin and remove, and look after the shelves.

type Shelf = { id: string; name: string; sortOrder: number; items: number };
type Card = {
  id: string; shelfId: string; brandId: string | null; brandName: string | null; title: string; pinned: boolean;
  snippet: string; linkCount: number; updatedAt: string; updatedByName: string | null;
};
type Link = { label: string; url: string };
type Item = Omit<Card, "snippet" | "linkCount"> & {
  shelfName: string; body: string; links: Link[]; createdAt: string; createdByName: string | null;
};
type Hub = { shelves: Shelf[]; items: Card[]; canEdit: boolean };
type Draft = { id?: string; shelfId: string; brandId: string | null; title: string; body: string; links: Link[]; pinned: boolean };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function KnowledgePage() {
  const { workspaces } = useWorkspaces();
  const [params, setParams] = useSearchParams();
  const open = params.get("item");
  const [hub, setHub] = useState<Hub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shelf, setShelf] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [q, setQ] = useState("");
  const [shelvesOpen, setShelvesOpen] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (shelf) p.set("shelf", shelf);
    if (brand) p.set("brand", brand);
    if (q.trim()) p.set("q", q.trim());
    try {
      const qs = p.toString();
      setHub(await api<Hub>(`/knowledge${qs ? `?${qs}` : ""}`));
      setError(null);
    } catch (e) {
      setError(errText(e, "Couldn't load the Knowledge Hub."));
    }
  }, [shelf, brand, q]);
  // the search waits for a pause in typing
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  const go = (item: string | null) => setParams(item ? { item } : {}, { replace: false });
  const shelfName = useMemo(() => new Map((hub?.shelves ?? []).map((s) => [s.id, s.name])), [hub]);
  const total = (hub?.shelves ?? []).reduce((n, s) => n + s.items, 0);

  if (open) {
    return (
      <section className="screen pp kh">
        <ItemView key={open} id={open} hub={hub} brands={workspaces} onBack={() => go(null)} onSaved={(id) => { load(); go(id); }} onGone={() => { load(); go(null); }} />
      </section>
    );
  }
  return (
    <section className="screen pp kh">
      <div className="pp-top">
        <div className="pp-title">
          <h1>Knowledge Hub</h1>
          <span>SOPs, brand guidelines and training, written here, with links to the files.</span>
        </div>
        <span className="pp-grow" />
        {hub?.canEdit && <button type="button" className="kh-btn pri" onClick={() => go("new")}>New page</button>}
      </div>

      <div className="kh-bar">
        <input className="kh-in kh-search" type="search" placeholder="Search titles and pages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="kh-in" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
          <option value="">Every brand</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      <div className="kh-shelves" role="group" aria-label="Shelves">
        <button type="button" className={!shelf ? "on" : ""} onClick={() => setShelf("")}>All <span>{total}</span></button>
        {(hub?.shelves ?? []).map((s) => (
          <button key={s.id} type="button" className={shelf === s.id ? "on" : ""} onClick={() => setShelf(s.id)}>{s.name} <span>{s.items}</span></button>
        ))}
        {hub?.canEdit && <button type="button" className="kh-link" onClick={() => setShelvesOpen((v) => !v)}>{shelvesOpen ? "Done" : "Edit shelves"}</button>}
      </div>
      {shelvesOpen && hub && <ShelfEditor shelves={hub.shelves} onChange={load} />}

      {error ? <div className="pp-card kh-empty">{error}</div>
        : !hub ? <div className="pp-card kh-empty">Loading…</div>
        : !hub.items.length ? (
          <div className="pp-card kh-empty">
            {q || shelf || brand ? "Nothing here matches. Try another word or shelf."
              : hub.canEdit ? "Nothing on the shelves yet. Add the first SOP, brand guide or training page." : "Nothing on the shelves yet."}
          </div>
        ) : (
          <div className="kh-grid">
            {hub.items.map((c) => (
              <button key={c.id} type="button" className="pp-card kh-card" onClick={() => go(c.id)}>
                <span className="kh-meta">
                  {c.pinned && <span className="kh-pin">Pinned</span>}
                  {shelfName.get(c.shelfId)}{c.brandName ? ` · ${c.brandName}` : ""}
                </span>
                <b>{c.title}</b>
                {c.snippet && <span className="kh-snip">{c.snippet}</span>}
                <span className="kh-foot">
                  {c.linkCount > 0 && <span>{c.linkCount === 1 ? "1 link" : `${c.linkCount} links`}</span>}
                  <span>Updated {day(c.updatedAt)}{c.updatedByName ? ` by ${c.updatedByName}` : ""}</span>
                </span>
              </button>
            ))}
          </div>
        )}
    </section>
  );
}

// One page: read it, or (?item=new, or Edit) write it.
function ItemView({ id, hub, brands, onBack, onSaved, onGone }: {
  id: string; hub: Hub | null; brands: { id: string; name: string }[];
  onBack: () => void; onSaved: (id: string) => void; onGone: () => void;
}) {
  const [item, setItem] = useState<Item | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (id === "new") return;
    api<{ item: Item; canEdit: boolean }>(`/knowledge/${id}`)
      .then((r) => { setItem(r.item); setCanEdit(r.canEdit); })
      .catch((e) => setError(errText(e, "Couldn't open that page.")));
  }, [id]);
  // a new page: on the shelf in view, or the first one
  useEffect(() => {
    if (id !== "new" || !hub || draft) return;
    if (hub.canEdit) setDraft({ shelfId: hub.shelves[0]?.id ?? "", brandId: null, title: "", body: "", links: [], pinned: false });
    else setError("Adding pages is for the Managers and Team Leads.");
  }, [id, hub, draft]);

  const back = <button type="button" className="kh-link kh-back" onClick={onBack}>← Knowledge Hub</button>;
  if (error) return <>{back}<div className="pp-card kh-empty">{error}</div></>;
  if (draft && hub) {
    return (
      <>
        {back}
        <Editor draft={draft} setDraft={setDraft} shelves={hub.shelves} brands={brands}
          onCancel={() => (id === "new" ? onBack() : setDraft(null))}
          onSaved={(saved) => { setDraft(null); setItem(saved); onSaved(saved.id); }}
          onDeleted={onGone} />
      </>
    );
  }
  if (!item) return <>{back}<div className="pp-card kh-empty">Loading…</div></>;
  return (
    <>
      {back}
      <article className="pp-card kh-read">
        <div className="kh-readhead">
          <span className="kh-meta">
            {item.pinned && <span className="kh-pin">Pinned</span>}
            {item.shelfName}{item.brandName ? ` · ${item.brandName}` : " · Company-wide"}
          </span>
          <h2>{item.title}</h2>
          <span className="kh-by">
            Updated {day(item.updatedAt)}{item.updatedByName ? ` by ${item.updatedByName}` : ""}
            {item.createdByName && item.createdByName !== item.updatedByName ? ` · added by ${item.createdByName}` : ""}
          </span>
          {canEdit && hub && (
            <button type="button" className="kh-btn" onClick={() => setDraft({
              id: item.id, shelfId: item.shelfId, brandId: item.brandId, title: item.title, body: item.body, links: item.links, pinned: item.pinned,
            })}>Edit</button>
          )}
        </div>
        {item.body.trim() ? <RichText text={item.body} className="kh-body" /> : <p className="kh-none">No page written yet{item.links.length ? ": see the links below." : "."}</p>}
        {item.links.length > 0 && (
          <div className="kh-links">
            <b>Files and links</b>
            {item.links.map((l, n) => (
              <a key={n} href={l.url} target="_blank" rel="noopener noreferrer">
                <span>{l.label || hostOf(l.url)}</span><small>{hostOf(l.url)}</small>
              </a>
            ))}
          </div>
        )}
      </article>
    </>
  );
}

function Editor({ draft, setDraft, shelves, brands, onCancel, onSaved, onDeleted }: {
  draft: Draft; setDraft: (d: Draft) => void; shelves: Shelf[]; brands: { id: string; name: string }[];
  onCancel: () => void; onSaved: (item: Item) => void; onDeleted: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setLink = (n: number, patch: Partial<Link>) => set({ links: draft.links.map((l, i) => (i === n ? { ...l, ...patch } : l)) });

  async function save() {
    setBusy(true);
    try {
      const body = JSON.stringify({ ...draft, id: undefined, links: draft.links.filter((l) => l.url.trim()).map((l) => ({ label: l.label.trim(), url: l.url.trim() })) });
      const r = draft.id
        ? await api<{ item: Item }>(`/knowledge/${draft.id}`, { method: "PATCH", body })
        : await api<{ item: Item }>("/knowledge", { method: "POST", body });
      toast.success(draft.id ? "Saved." : "Added to the Knowledge Hub.");
      onSaved(r.item);
    } catch (e) {
      toast.error(errText(e, "Couldn't save it."));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!draft.id || !window.confirm(`Remove “${draft.title}” from the Knowledge Hub?`)) return;
    try {
      await api(`/knowledge/${draft.id}`, { method: "DELETE" });
      toast.success("Removed.");
      onDeleted();
    } catch (e) {
      toast.error(errText(e, "Couldn't remove it."));
    }
  }

  return (
    <section className="pp-card kh-edit">
      <label className="kh-field">
        <span>Title</span>
        <input className="kh-in" value={draft.title} maxLength={120} placeholder="For example: How we hand over a finished reel" onChange={(e) => set({ title: e.target.value })} autoFocus={!draft.id} />
      </label>
      <div className="kh-row">
        <label className="kh-field">
          <span>Shelf</span>
          <select className="kh-in" value={draft.shelfId} onChange={(e) => set({ shelfId: e.target.value })}>
            {shelves.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="kh-field">
          <span>Brand</span>
          <select className="kh-in" value={draft.brandId ?? ""} onChange={(e) => set({ brandId: e.target.value || null })}>
            <option value="">Company-wide</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="kh-check">
          <input type="checkbox" checked={draft.pinned} onChange={(e) => set({ pinned: e.target.checked })} />
          Pin to the top
        </label>
      </div>

      <div className="kh-field">
        <span className="kh-tabs">
          Page
          <button type="button" className={!preview ? "on" : ""} onClick={() => setPreview(false)}>Write</button>
          <button type="button" className={preview ? "on" : ""} onClick={() => setPreview(true)}>Preview</button>
        </span>
        {preview
          ? <div className="kh-preview">{draft.body.trim() ? <RichText text={draft.body} className="kh-body" /> : <p className="kh-none">Nothing written yet.</p>}</div>
          : <textarea className="kh-in kh-text" rows={16} value={draft.body} maxLength={50000} onChange={(e) => set({ body: e.target.value })}
              placeholder={"# Steps\n1. Export at 1080 × 1920\n2. Upload to the brand's Drive folder\n\n**Check before handing over:** captions, music licence"} />}
        <small className="kh-help">{RICH_TEXT_HELP}</small>
      </div>

      <div className="kh-field">
        <span>Files and links <small>Google Drive, Docs, Sheets, YouTube…</small></span>
        {draft.links.map((l, n) => (
          <div key={n} className="kh-linkrow">
            <input className="kh-in" placeholder="Name (optional)" maxLength={80} value={l.label} onChange={(e) => setLink(n, { label: e.target.value })} aria-label="Link name" />
            <input className="kh-in kh-grow" placeholder="https://drive.google.com/…" value={l.url} onChange={(e) => setLink(n, { url: e.target.value })} aria-label="Link address" />
            <button type="button" className="kh-link" onClick={() => set({ links: draft.links.filter((_, i) => i !== n) })} aria-label="Remove this link">Remove</button>
          </div>
        ))}
        {draft.links.length < 20 && <button type="button" className="kh-link" onClick={() => set({ links: [...draft.links, { label: "", url: "" }] })}>+ Add a link</button>}
      </div>

      <div className="kh-actions">
        {draft.id && <button type="button" className="kh-btn danger" onClick={remove} disabled={busy}>Remove</button>}
        <span className="pp-grow" />
        <button type="button" className="kh-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="kh-btn pri" onClick={save} disabled={busy || !draft.title.trim() || !draft.shelfId}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </section>
  );
}

// The shelves: rename, add, and remove an empty one.
function ShelfEditor({ shelves, onChange }: { shelves: Shelf[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  async function run(fn: () => Promise<unknown>, done?: string) {
    try { await fn(); if (done) toast.success(done); } catch (e) { toast.error(errText(e, "Couldn't change the shelves.")); }
    onChange();
  }
  return (
    <div className="pp-card kh-shelfedit">
      {shelves.map((s) => (
        <div key={s.id} className="kh-linkrow">
          <input className="kh-in kh-grow" value={names[s.id] ?? s.name} maxLength={40} aria-label={`Rename ${s.name}`}
            onChange={(e) => setNames({ ...names, [s.id]: e.target.value })}
            onBlur={() => { const v = (names[s.id] ?? s.name).trim(); if (v && v !== s.name) run(() => api(`/knowledge/shelves/${s.id}`, { method: "PATCH", body: JSON.stringify({ name: v }) }), "Renamed."); }} />
          <span className="kh-count">{s.items === 1 ? "1 page" : `${s.items} pages`}</span>
          <button type="button" className="kh-link" disabled={s.items > 0} title={s.items > 0 ? "Move or remove its pages first" : undefined}
            onClick={() => window.confirm(`Remove the shelf ${s.name}?`) && run(() => api(`/knowledge/shelves/${s.id}`, { method: "DELETE" }), "Shelf removed.")}>Remove</button>
        </div>
      ))}
      <div className="kh-linkrow">
        <input className="kh-in kh-grow" placeholder="A new shelf, for example: Onboarding" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="kh-btn" disabled={!name.trim()}
          onClick={() => run(() => api("/knowledge/shelves", { method: "POST", body: JSON.stringify({ name: name.trim() }) }).then(() => setName("")), "Shelf added.")}>Add shelf</button>
      </div>
    </div>
  );
}
