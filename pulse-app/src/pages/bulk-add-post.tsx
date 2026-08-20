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
  // Collab linkage (owner + mirror share collabGroupId).
  collabGroupId?: string;
  isMirror?: boolean;          // this row is the collaborating channel's mirror
  overrides?: Set<string>;     // mirror fields the user edited (skip propagation)
};

// A card groups several posts under one channel — the channel is the card
// header, so rows no longer carry a channel column.
type Card = { id: string; channelId: string; rows: Row[]; viaCollab?: boolean };

// Fields that propagate owner → mirror (until the mirror overrides them).
const MIRROR_DIRECT = ["date", "title", "link", "postType"] as const;
const MIRROR_TAXONOMY = ["pillarId", "contentTypeId", "formatId", "avatarId"] as const;

let seq = 0;
const newKey = () => `r${seq++}`;
const newGroup = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `g${seq++}-${Date.now()}`);
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
  const igPlatformId = platforms.find((p) => p.key === "instagram")?.id ?? "";

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
  const isInstagram = (platformId: string) => platforms.find((p) => p.id === platformId)?.key === "instagram";
  const channelHasInstagram = (channelId: string) =>
    accounts.some((a) => a.channel_id === channelId && a.platform_key === "instagram");
  // Channels offered as collab partners: other channels that are on Instagram.
  const collabOptions = (fromChannel: string) =>
    workspaces.filter((w) => w.id !== fromChannel && channelHasInstagram(w.id));

  useEffect(() => {
    if (!pickChannel && defaultChannel) setPickChannel(defaultChannel);
  }, [defaultChannel, pickChannel]);

  // Backfill a default platform for rows once accounts/platforms load.
  useEffect(() => {
    setCards((cs) => {
      let changed = false;
      const next = cs.map((c) => {
        const pfs = platformsFor(c.channelId);
        if (!pfs.length) return c;
        let rowChanged = false;
        const rows = c.rows.map((r) => {
          if (r.platformId) return r;
          rowChanged = true; changed = true;
          return { ...r, platformId: pfs[0].id };
        });
        return rowChanged ? { ...c, rows } : c;
      });
      return changed ? next : cs;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctData, platData]);

  // ---- Collab taxonomy mapping (ids differ per channel — match by name) ----
  function mapTaxonomy(srcChannelId: string, tgtChannelId: string, src: Row) {
    const s = taxByChannel[srcChannelId], t = taxByChannel[tgtChannelId];
    if (!s || !t) return { pillarId: "", contentTypeId: "", formatId: "", avatarId: "" };
    const sp = s.pillars.find((p) => p.id === src.pillarId);
    const tp = sp ? t.pillars.find((p) => p.name === sp.name) : undefined;
    const sct = s.contentTypes.find((c) => c.id === src.contentTypeId);
    const tct = sct && tp ? t.contentTypes.find((c) => c.name === sct.name && c.pillar_id === tp.id) : undefined;
    // Format is flat now — map by name across channels, independent of pillar.
    const sf = s.formats.find((f) => f.id === src.formatId);
    const tf = sf ? t.formats.find((f) => f.name === sf.name) : undefined;
    const sa = s.avatars.find((a) => a.id === src.avatarId);
    const ta = sa ? t.avatars.find((a) => a.name === sa.name) : undefined;
    return { pillarId: tp?.id ?? "", contentTypeId: tct?.id ?? "", formatId: tf?.id ?? "", avatarId: ta?.id ?? "" };
  }

  function buildMirror(srcChannelId: string, tgtChannelId: string, src: Row, groupId: string): Row {
    const tax = mapTaxonomy(srcChannelId, tgtChannelId, src);
    return {
      ...blankRow(igPlatformId),
      date: src.date, title: src.title, link: src.link, postType: src.postType, status: src.status,
      ...tax,
      editorId: "",
      collabChannelId: srcChannelId, // reciprocal — points back to the source channel
      collabGroupId: groupId,
      isMirror: true,
      overrides: new Set<string>(),
    };
  }

  // Remove a group's mirror row; drop the card too if it was auto-created & empty.
  function stripMirror(cs: Card[], groupId: string): Card[] {
    return cs
      .map((c) => ({ ...c, rows: c.rows.filter((r) => !(r.collabGroupId === groupId && r.isMirror)) }))
      .filter((c) => !(c.rows.length === 0 && c.viaCollab));
  }

  // Push owner edits onto the mirror, skipping fields the mirror overrode.
  function propagate(cs: Card[], groupId: string, srcRow: Row, srcChannelId: string): Card[] {
    return cs.map((c) => {
      const idx = c.rows.findIndex((r) => r.collabGroupId === groupId && r.isMirror);
      if (idx < 0) return c;
      const mirror = c.rows[idx];
      const ov = mirror.overrides ?? new Set<string>();
      const tax = mapTaxonomy(srcChannelId, c.channelId, srcRow);
      const patch: Partial<Row> = {};
      for (const f of MIRROR_DIRECT) if (!ov.has(f)) (patch as Record<string, unknown>)[f] = srcRow[f];
      for (const f of MIRROR_TAXONOMY) if (!ov.has(f)) (patch as Record<string, unknown>)[f] = tax[f];
      const rows = [...c.rows];
      rows[idx] = { ...mirror, ...patch };
      return { ...c, rows };
    });
  }

  // Collab dropdown changed on a source row → create / move / remove the mirror.
  function changeCollab(cardId: string, key: string, newTarget: string) {
    const srcCard = cards.find((c) => c.id === cardId);
    const srcRow = srcCard?.rows.find((r) => r.key === key);
    if (!srcCard || !srcRow) return;
    const oldGroup = srcRow.collabGroupId;

    // If an existing mirror was hand-edited, don't silently drop it — confirm.
    if (oldGroup && newTarget !== srcRow.collabChannelId) {
      const mirror = cards.flatMap((c) => c.rows).find((r) => r.collabGroupId === oldGroup && r.isMirror);
      if (mirror && (mirror.overrides?.size ?? 0) > 0) {
        const ok = window.confirm(
          `The mirrored post on “${channelName(mirror.collabChannelId)}” has your edits. Change the collab and remove it?`,
        );
        if (!ok) return; // abort — dropdown reverts to its current value
      }
    }

    setCards((cs) => {
      let next = oldGroup ? stripMirror(cs, oldGroup) : cs;
      if (!newTarget) {
        return patchRow(next, cardId, key, { collabChannelId: "", collabGroupId: undefined });
      }
      const groupId = newGroup();
      next = patchRow(next, cardId, key, { collabChannelId: newTarget, collabGroupId: groupId, isMirror: false });
      const updatedSrc = { ...srcRow, collabChannelId: newTarget, collabGroupId: groupId };
      const mirrorRow = buildMirror(srcCard.channelId, newTarget, updatedSrc, groupId);
      const tgt = next.find((c) => c.channelId === newTarget);
      if (tgt) {
        next = next.map((c) => (c.id === tgt.id ? { ...c, rows: [...c.rows, mirrorRow] } : c));
      } else {
        next = [...next, { id: `c${seq++}`, channelId: newTarget, viaCollab: true, rows: [mirrorRow] }];
      }
      return next;
    });
  }

  function patchRow(cs: Card[], cardId: string, key: string, patch: Partial<Row>): Card[] {
    return cs.map((c) => (c.id === cardId ? { ...c, rows: c.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } : c));
  }

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
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, rows: [...c.rows, blankRow(platformsFor(c.channelId)[0]?.id ?? "")] } : c)));
  }
  // Delete a row, cleaning up any collab link it participates in.
  function delRow(cardId: string, key: string) {
    const card = cards.find((c) => c.id === cardId);
    const row = card?.rows.find((r) => r.key === key);
    if (!row) return;
    setCards((cs) => {
      // Deleting the source → also remove its mirror.
      if (row.collabGroupId && !row.isMirror) {
        let next = stripMirror(cs, row.collabGroupId);
        next = next.map((c) => (c.id === cardId ? { ...c, rows: c.rows.filter((r) => r.key !== key) } : c));
        return next.filter((c) => !(c.rows.length === 0 && c.viaCollab));
      }
      // Deleting the mirror → unlink its source's collab.
      if (row.collabGroupId && row.isMirror) {
        let next = cs.map((c) => (c.id === cardId ? { ...c, rows: c.rows.filter((r) => r.key !== key) } : c));
        next = next.map((c) => ({
          ...c,
          rows: c.rows.map((r) => (r.collabGroupId === row.collabGroupId && !r.isMirror ? { ...r, collabChannelId: "", collabGroupId: undefined } : r)),
        }));
        return next.filter((c) => !(c.rows.length === 0 && c.viaCollab));
      }
      // Plain row — keep at least one per card.
      return cs.map((c) => (c.id === cardId && c.rows.length > 1 ? { ...c, rows: c.rows.filter((r) => r.key !== key) } : c));
    });
  }

  function update(cardId: string, key: string, patch: Partial<Row>) {
    if ("collabChannelId" in patch) { changeCollab(cardId, key, patch.collabChannelId ?? ""); return; }
    setCards((cs) => {
      const card = cs.find((c) => c.id === cardId);
      const before = card?.rows.find((r) => r.key === key);
      if (!before) return cs;

      const apply = (r: Row, channelId: string): Row => {
        let n = { ...r, ...patch };
        if (patch.platformId !== undefined && !isInstagram(patch.platformId)) n.collabChannelId = "";
        if (patch.pillarId !== undefined && patch.pillarId !== r.pillarId) n = { ...n, contentTypeId: "", formatId: "" };
        if (patch.formatId !== undefined && patch.formatId !== r.formatId) {
          const fmt = taxByChannel[channelId]?.formats.find((f) => f.id === patch.formatId);
          if (fmt) n.postType = fmt.post_type;
        }
        return n;
      };

      let next = cs.map((c) => (c.id !== cardId ? c : { ...c, rows: c.rows.map((r) => (r.key === key ? apply(r, c.channelId) : r)) }));

      // Editing a mirror marks those fields overridden (pillar also freezes ct/format).
      if (before.isMirror) {
        const fields = Object.keys(patch);
        next = next.map((c) => (c.id !== cardId ? c : {
          ...c,
          rows: c.rows.map((r) => {
            if (r.key !== key) return r;
            const ov = new Set(r.overrides ?? []);
            fields.forEach((f) => ov.add(f));
            if (fields.includes("pillarId")) { ov.add("contentTypeId"); ov.add("formatId"); }
            return { ...r, overrides: ov };
          }),
        }));
      }

      // Editing a linked source propagates to its mirror.
      if (before.collabGroupId && !before.isMirror) {
        const updatedSrc = next.find((c) => c.id === cardId)!.rows.find((r) => r.key === key)!;
        next = propagate(next, before.collabGroupId, updatedSrc, card!.channelId);
      }
      return next;
    });
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
            collabGroupId: r.collabGroupId || null, isCollabMirror: !!r.isMirror,
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
      <div className="bulk-sub">Pick a channel, then add its posts. Setting a Collab mirrors the post onto that channel.</div>

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
                {card.viaCollab && <span className="bulk-viacollab" title="Auto-created from a collab">🤝 via collab</span>}
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
                      const fmts = tax?.formats ?? []; // flat: channel-wide, never gated by pillar
                      return (
                        <tr key={r.key} className={r.isMirror ? "bulk-mirror-row" : undefined}>
                          <td className="bulk-num">{i + 1}{r.isMirror && <div className="bulk-mtag">collab</div>}</td>
                          <td>
                            <select value={r.platformId} disabled={r.isMirror} onChange={(e) => update(card.id, r.key, { platformId: e.target.value })}>
                              {pfs.length === 0 && <option value="">—</option>}
                              {pfs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                          <td><input type="date" value={r.date} onChange={(e) => update(card.id, r.key, { date: e.target.value })} /></td>
                          <td className="bulk-title"><input placeholder="Post title" value={r.title} onChange={(e) => update(card.id, r.key, { title: e.target.value })} /></td>
                          <td><input placeholder="https://…" value={r.link} onChange={(e) => update(card.id, r.key, { link: e.target.value })} /></td>
                          <td>
                            {r.isMirror ? (
                              <span className="bulk-collab-recip" title="Mirrored from a collab">↔ {channelName(r.collabChannelId)}</span>
                            ) : isInstagram(r.platformId) ? (
                              <select value={r.collabChannelId} onChange={(e) => update(card.id, r.key, { collabChannelId: e.target.value })}>
                                <option value="">None</option>
                                {collabOptions(card.channelId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                              </select>
                            ) : (
                              <span className="bulk-na" title="Collab is Instagram-only">—</span>
                            )}
                          </td>
                          <td>
                            <select value={r.pillarId} onChange={(e) => update(card.id, r.key, { pillarId: e.target.value })}>
                              <option value="">Select…</option>
                              {(tax?.pillars ?? []).map((p) => <option key={p.id} value={p.id}>P{p.serial} — {p.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.contentTypeId} disabled={!r.pillarId} onChange={(e) => update(card.id, r.key, { contentTypeId: e.target.value })}>
                              <option value="">{r.pillarId ? "Select…" : "Pillar first"}</option>
                              {cts.map((c) => <option key={c.id} value={c.id}>T{c.serial} — {c.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.formatId} onChange={(e) => update(card.id, r.key, { formatId: e.target.value })}>
                              <option value="">Select…</option>
                              {fmts.map((f) => <option key={f.id} value={f.id}>F{f.serial} — {f.name}</option>)}
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
                            <select value={r.editorId} disabled={r.isMirror} title={r.isMirror ? "Mirror has no editor — one task lives on the owner post" : undefined} onChange={(e) => update(card.id, r.key, { editorId: e.target.value })}>
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
                            <button title="Delete row" onClick={() => delRow(card.id, r.key)} disabled={card.rows.length === 1 && !r.isMirror}>🗑</button>
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
        Comments, Shares, Saves &amp; Accounts Reached on each post (or sync from Instagram). Collab mirrors don't
        count toward views/score anywhere, and never toward org-wide totals.
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
