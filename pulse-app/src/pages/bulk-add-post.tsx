import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { useEditors } from "@/lib/use-editors";
import { api } from "@/lib/api";
import type { Platform, Account, Taxonomy } from "@/lib/types";

type Row = {
  key: string;
  platformId: string;
  date: string;
  title: string;
  link: string;
  collabChannelId: string;
  pillarId: string;
  contentTypeId: string;
  formatId: string;
  postType: "" | "reel" | "carousel";
  avatarId: string;
  editorId: string;
  status: "planned" | "published";
};

// A card groups several posts under one channel — the channel is the card
// header, so rows no longer carry a channel column.
type Card = { id: string; channelId: string; rows: Row[] };

let seq = 0;
const newKey = () => `r${seq++}`;
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function blankRow(platformId = ""): Row {
  return {
    key: newKey(), platformId, date: today(), title: "", link: "",
    collabChannelId: "", pillarId: "", contentTypeId: "", formatId: "", postType: "", avatarId: "",
    editorId: "", status: "planned",
  };
}

const ROWS_PER_NEW_CARD = 1;

export function BulkAddPostPage({ onClose }: { onClose?: () => void } = {}) {
  const navigate = useNavigate();
  const close = () => (onClose ? onClose() : navigate("/posts"));
  const { workspaces, active } = useWorkspaces();
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { data: acctData } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const { editors } = useEditors();
  const platforms = platData?.platforms ?? [];
  const accounts = acctData?.accounts ?? [];
  const defaultChannel = active?.id ?? workspaces[0]?.id ?? "";

  // Taxonomy for every channel (each row shows its channel's pillars/formats).
  const [taxByChannel, setTaxByChannel] = useState<Record<string, Taxonomy>>({});
  useEffect(() => {
    let cancel = false;
    Promise.all(
      workspaces.map((w) =>
        api<Taxonomy>(`/taxonomy?channel=${w.id}`).then((t) => [w.id, t] as const).catch(() => null),
      ),
    ).then((pairs) => {
      if (cancel) return;
      const m: Record<string, Taxonomy> = {};
      for (const p of pairs) if (p) m[p[0]] = p[1];
      setTaxByChannel(m);
    });
    return () => { cancel = true; };
  }, [workspaces]);

  const [cards, setCards] = useState<Card[]>([]);
  const [pickChannel, setPickChannel] = useState("");
  const [saving, setSaving] = useState(false);

  const channelName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "Channel";
  const platformsFor = (channelId: string): Platform[] => {
    const ids = new Set(accounts.filter((a) => a.channel_id === channelId).map((a) => a.platform_id));
    return platforms.filter((p) => ids.has(p.id));
  };
  // Collab is an Instagram-only concept.
  const isInstagram = (platformId: string) => platforms.find((p) => p.id === platformId)?.key === "instagram";

  // Default the channel picker once workspaces load.
  useEffect(() => {
    if (!pickChannel && defaultChannel) setPickChannel(defaultChannel);
  }, [defaultChannel, pickChannel]);

  // Once accounts/platforms load, backfill any row missing a default platform.
  // Return the SAME cards reference when nothing changes so React bails out —
  // otherwise this re-renders forever (the data arrays are fresh each render).
  useEffect(() => {
    setCards((cs) => {
      let changed = false;
      const next = cs.map((c) => {
        const pfs = platformsFor(c.channelId);
        if (!pfs.length) return c;
        let rowChanged = false;
        const rows = c.rows.map((r) => {
          if (r.platformId) return r;
          rowChanged = true;
          changed = true;
          return { ...r, platformId: pfs[0].id };
        });
        return rowChanged ? { ...c, rows } : c;
      });
      return changed ? next : cs;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctData, platData]);

  function addCard(channelId: string) {
    if (!channelId) return;
    const pf = platformsFor(channelId)[0]?.id ?? "";
    const rows = Array.from({ length: ROWS_PER_NEW_CARD }, () => blankRow(pf));
    setCards((cs) => [...cs, { id: `c${seq++}`, channelId, rows }]);
  }
  function delCard(id: string) {
    setCards((cs) => cs.filter((c) => c.id !== id));
  }
  function addRow(cardId: string) {
    setCards((cs) =>
      cs.map((c) => (c.id === cardId ? { ...c, rows: [...c.rows, blankRow(platformsFor(c.channelId)[0]?.id ?? "")] } : c)),
    );
  }
  function dupRow(cardId: string, key: string) {
    setCards((cs) =>
      cs.map((c) => {
        if (c.id !== cardId) return c;
        const i = c.rows.findIndex((r) => r.key === key);
        return { ...c, rows: [...c.rows.slice(0, i + 1), { ...c.rows[i], key: newKey() }, ...c.rows.slice(i + 1)] };
      }),
    );
  }
  function delRow(cardId: string, key: string) {
    setCards((cs) =>
      cs.map((c) => (c.id === cardId && c.rows.length > 1 ? { ...c, rows: c.rows.filter((r) => r.key !== key) } : c)),
    );
  }
  function update(cardId: string, key: string, patch: Partial<Row>) {
    setCards((cs) =>
      cs.map((c) => {
        if (c.id !== cardId) return c;
        return {
          ...c,
          rows: c.rows.map((r) => {
            if (r.key !== key) return r;
            let n = { ...r, ...patch };
            // Collab only applies to Instagram — clear it on any other platform.
            if (patch.platformId !== undefined && !isInstagram(patch.platformId)) n.collabChannelId = "";
            if (patch.pillarId !== undefined && patch.pillarId !== r.pillarId) n = { ...n, contentTypeId: "", formatId: "" };
            if (patch.formatId !== undefined && patch.formatId !== r.formatId) {
              const fmt = taxByChannel[c.channelId]?.formats.find((f) => f.id === patch.formatId);
              if (fmt) n.postType = fmt.post_type;
            }
            return n;
          }),
        };
      }),
    );
  }

  const validRow = (r: Row) =>
    r.platformId && r.date && r.title.trim() && r.pillarId && r.contentTypeId && r.formatId && r.postType && r.avatarId;

  const totalPosts = cards.reduce((n, c) => n + c.rows.length, 0);

  async function saveAll() {
    const flat = cards.flatMap((c) => c.rows.map((r) => ({ channelId: c.channelId, r })));
    if (!flat.length) { toast.error("Add a channel card first."); return; }
    const bad = flat.filter((x) => !validRow(x.r)).length;
    if (bad) { toast.error(`Fill the required (*) fields in ${bad} post${bad === 1 ? "" : "s"}.`); return; }
    setSaving(true);
    let ok = 0, fail = 0;
    for (const { channelId, r } of flat) {
      try {
        await api("/posts", {
          method: "POST",
          body: JSON.stringify({
            channelId, platformId: r.platformId, date: r.date, title: r.title.trim(),
            link: r.link || undefined, collabChannelId: r.collabChannelId || null,
            pillarId: r.pillarId, contentTypeId: r.contentTypeId, formatId: r.formatId,
            postType: r.postType, avatarId: r.avatarId, editorId: r.editorId || undefined, status: r.status,
          }),
        });
        ok++;
      } catch { fail++; }
    }
    setSaving(false);
    if (ok) { toast.success(`${ok} post${ok === 1 ? "" : "s"} saved${fail ? `, ${fail} failed` : ""}.`); navigate("/posts"); }
    else toast.error("Could not save posts.");
  }

  return (
    <Modal onClose={close} title="Add Multiple Posts" wide>
      <div className="bulk-sub">Pick a channel, then add its posts. Each channel gets its own card.</div>

      {cards.length === 0 ? (
        <div className="bulk-empty">
          <div className="bulk-empty-h">Which channel are these posts for?</div>
          <div className="bulk-pick">
            <select className="t" value={pickChannel} onChange={(e) => setPickChannel(e.target.value)}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <button className="btn btn-primary" onClick={() => addCard(pickChannel)}>＋ Create channel card</button>
          </div>
        </div>
      ) : (
        <>
          {cards.map((card) => (
            <div className="bulk-card" key={card.id}>
              <div className="bulk-card-head">
                <span className="bulk-card-ic">🌐</span>
                <h4>{channelName(card.channelId)}</h4>
                <span className="bulk-card-count">{card.rows.length} post{card.rows.length === 1 ? "" : "s"}</span>
                <button className="bulk-card-del" title="Remove this channel card" onClick={() => delCard(card.id)}>Remove</button>
              </div>
              <div className="bulk-scroll">
                <table className="bulk-tbl bulk-tbl-card">
                  <thead>
                    <tr>
                      <th>#</th><th>Platform *</th><th>Date *</th><th>Title *</th>
                      <th>Link</th><th>Collab</th><th>Pillar *</th><th>Content Type *</th>
                      <th>Format *</th><th>Post Type *</th><th>Avatar *</th><th>Editor</th><th>Status</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.rows.map((r, i) => {
                      const tax = taxByChannel[card.channelId];
                      const pfs = platformsFor(card.channelId);
                      const cts = tax?.contentTypes.filter((c) => c.pillar_id === r.pillarId) ?? [];
                      const fmts = tax?.formats.filter((f) => f.pillar_id === r.pillarId) ?? [];
                      return (
                        <tr key={r.key}>
                          <td className="bulk-num">{i + 1}</td>
                          <td>
                            <select value={r.platformId} onChange={(e) => update(card.id, r.key, { platformId: e.target.value })}>
                              {pfs.length === 0 && <option value="">—</option>}
                              {pfs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                          <td><input type="date" value={r.date} onChange={(e) => update(card.id, r.key, { date: e.target.value })} /></td>
                          <td className="bulk-title"><input placeholder="Post title" value={r.title} onChange={(e) => update(card.id, r.key, { title: e.target.value })} /></td>
                          <td><input placeholder="https://…" value={r.link} onChange={(e) => update(card.id, r.key, { link: e.target.value })} /></td>
                          <td>
                            {isInstagram(r.platformId) ? (
                              <select value={r.collabChannelId} onChange={(e) => update(card.id, r.key, { collabChannelId: e.target.value })}>
                                <option value="">None</option>
                                {workspaces.filter((w) => w.id !== card.channelId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                              </select>
                            ) : (
                              <span className="bulk-na" title="Collab is Instagram-only">—</span>
                            )}
                          </td>
                          <td>
                            <select value={r.pillarId} onChange={(e) => update(card.id, r.key, { pillarId: e.target.value })}>
                              <option value="">Select…</option>
                              {(tax?.pillars ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.contentTypeId} disabled={!r.pillarId} onChange={(e) => update(card.id, r.key, { contentTypeId: e.target.value })}>
                              <option value="">{r.pillarId ? "Select…" : "Pillar first"}</option>
                              {cts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.formatId} disabled={!r.pillarId} onChange={(e) => update(card.id, r.key, { formatId: e.target.value })}>
                              <option value="">{r.pillarId ? "Select…" : "Pillar first"}</option>
                              {fmts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.postType} onChange={(e) => update(card.id, r.key, { postType: e.target.value as Row["postType"] })}>
                              <option value="">Select…</option>
                              <option value="reel">🎬 Reel</option>
                              <option value="carousel">🖼️ Carousel</option>
                            </select>
                          </td>
                          <td>
                            <select value={r.avatarId} onChange={(e) => update(card.id, r.key, { avatarId: e.target.value })}>
                              <option value="">Select…</option>
                              {(tax?.avatars ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.editorId} onChange={(e) => update(card.id, r.key, { editorId: e.target.value })}>
                              <option value="">Unassigned</option>
                              {(editors ?? []).map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.status} onChange={(e) => update(card.id, r.key, { status: e.target.value as Row["status"] })}>
                              <option value="planned">🕓 Planned</option>
                              <option value="published">✅ Published</option>
                            </select>
                          </td>
                          <td className="bulk-actions">
                            <button title="Duplicate row" onClick={() => dupRow(card.id, r.key)}>⧉</button>
                            <button title="Delete row" onClick={() => delRow(card.id, r.key)} disabled={card.rows.length === 1}>🗑</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button className="bulk-add-row" onClick={() => addRow(card.id)}>＋ Add row</button>
            </div>
          ))}

          <div className="bulk-addchan">
            <span className="bulk-addchan-l">Add another channel:</span>
            <select className="t" value={pickChannel} onChange={(e) => setPickChannel(e.target.value)}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <button className="bulk-add" style={{ width: "auto", margin: 0, padding: "10px 18px" }} onClick={() => addCard(pickChannel)}>
              ＋ Add Another Post
            </button>
          </div>
        </>
      )}

      <div className="bulk-note">
        <b>ℹ️ Performance metrics</b> — posts are saved as <b>Planned</b>. After publishing, log Views, Likes,
        Comments, Shares, Saves &amp; Accounts Reached on each post (or sync from Instagram).
      </div>
      <div className="formfoot">
        <span style={{ marginRight: "auto", color: "var(--muted)", fontSize: 13, fontWeight: 700 }}>
          {totalPosts} post{totalPosts === 1 ? "" : "s"} across {cards.length} channel{cards.length === 1 ? "" : "s"}
        </span>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={saveAll} disabled={saving || totalPosts === 0}>
          {saving ? "Saving…" : "Save All Posts"}
        </button>
      </div>
    </Modal>
  );
}
