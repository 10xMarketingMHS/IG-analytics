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
  channelId: string;
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

let seq = 0;
const newKey = () => `r${seq++}`;
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function blank(channelId: string): Row {
  return {
    key: newKey(), channelId, platformId: "", date: today(), title: "", link: "",
    collabChannelId: "", pillarId: "", contentTypeId: "", formatId: "", postType: "", avatarId: "",
    editorId: "", status: "planned",
  };
}

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

  const [rows, setRows] = useState<Row[]>([blank("")]);
  const [saving, setSaving] = useState(false);

  const platformsFor = (channelId: string): Platform[] => {
    const ids = new Set(accounts.filter((a) => a.channel_id === channelId).map((a) => a.platform_id));
    return platforms.filter((p) => ids.has(p.id));
  };

  // Seed the first row's channel + each row's default platform once data loads.
  useEffect(() => {
    setRows((rs) =>
      rs.map((r) => {
        let n = r;
        if (!n.channelId && defaultChannel) n = { ...n, channelId: defaultChannel };
        if (!n.platformId && n.channelId) {
          const pfs = platformsFor(n.channelId);
          if (pfs.length) n = { ...n, platformId: pfs[0].id };
        }
        return n;
      }),
    );
  }, [defaultChannel, accounts, platforms]);

  function update(key: string, patch: Partial<Row>) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        let n = { ...r, ...patch };
        if (patch.channelId !== undefined && patch.channelId !== r.channelId) {
          const pfs = platformsFor(patch.channelId);
          n = { ...n, platformId: pfs[0]?.id ?? "", pillarId: "", contentTypeId: "", formatId: "", avatarId: "", collabChannelId: "" };
        }
        if (patch.pillarId !== undefined && patch.pillarId !== r.pillarId) {
          n = { ...n, contentTypeId: "", formatId: "" };
        }
        if (patch.formatId !== undefined && patch.formatId !== r.formatId) {
          const fmt = taxByChannel[n.channelId]?.formats.find((f) => f.id === patch.formatId);
          if (fmt) n.postType = fmt.post_type;
        }
        return n;
      }),
    );
  }

  const addRow = () => setRows((rs) => [...rs, blank(defaultChannel)]);
  const dupRow = (key: string) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      return [...rs.slice(0, i + 1), { ...rs[i], key: newKey() }, ...rs.slice(i + 1)];
    });
  const delRow = (key: string) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));

  const valid = (r: Row) =>
    r.channelId && r.platformId && r.date && r.title.trim() && r.pillarId && r.contentTypeId && r.formatId && r.postType && r.avatarId;

  async function saveAll() {
    const bad = rows.filter((r) => !valid(r)).length;
    if (bad) { toast.error(`Fill the required (*) fields in ${bad} row${bad === 1 ? "" : "s"}.`); return; }
    setSaving(true);
    let ok = 0, fail = 0;
    for (const r of rows) {
      try {
        await api("/posts", {
          method: "POST",
          body: JSON.stringify({
            channelId: r.channelId, platformId: r.platformId, date: r.date, title: r.title.trim(),
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
      <div className="bulk-sub">Create and manage multiple posts at once</div>
      <div className="bulk-scroll">
        <table className="bulk-tbl">
          <thead>
            <tr>
              <th>#</th><th>Channel *</th><th>Platform *</th><th>Date *</th><th>Title *</th>
              <th>Link</th><th>Collab</th><th>Pillar *</th><th>Content Type *</th>
              <th>Format *</th><th>Post Type *</th><th>Avatar *</th><th>Editor</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const tax = taxByChannel[r.channelId];
              const pfs = platformsFor(r.channelId);
              const cts = tax?.contentTypes.filter((c) => c.pillar_id === r.pillarId) ?? [];
              const fmts = tax?.formats.filter((f) => f.pillar_id === r.pillarId) ?? [];
              return (
                <tr key={r.key}>
                  <td className="bulk-num">{i + 1}</td>
                  <td>
                    <select value={r.channelId} onChange={(e) => update(r.key, { channelId: e.target.value })}>
                      {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.platformId} onChange={(e) => update(r.key, { platformId: e.target.value })}>
                      {pfs.length === 0 && <option value="">—</option>}
                      {pfs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td><input type="date" value={r.date} onChange={(e) => update(r.key, { date: e.target.value })} /></td>
                  <td className="bulk-title"><input placeholder="Post title" value={r.title} onChange={(e) => update(r.key, { title: e.target.value })} /></td>
                  <td><input placeholder="https://…" value={r.link} onChange={(e) => update(r.key, { link: e.target.value })} /></td>
                  <td>
                    <select value={r.collabChannelId} onChange={(e) => update(r.key, { collabChannelId: e.target.value })}>
                      <option value="">None</option>
                      {workspaces.filter((w) => w.id !== r.channelId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.pillarId} onChange={(e) => update(r.key, { pillarId: e.target.value })}>
                      <option value="">Select…</option>
                      {(tax?.pillars ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.contentTypeId} disabled={!r.pillarId} onChange={(e) => update(r.key, { contentTypeId: e.target.value })}>
                      <option value="">{r.pillarId ? "Select…" : "Pillar first"}</option>
                      {cts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.formatId} disabled={!r.pillarId} onChange={(e) => update(r.key, { formatId: e.target.value })}>
                      <option value="">{r.pillarId ? "Select…" : "Pillar first"}</option>
                      {fmts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.postType} onChange={(e) => update(r.key, { postType: e.target.value as Row["postType"] })}>
                      <option value="">Select…</option>
                      <option value="reel">🎬 Reel</option>
                      <option value="carousel">🖼️ Carousel</option>
                    </select>
                  </td>
                  <td>
                    <select value={r.avatarId} onChange={(e) => update(r.key, { avatarId: e.target.value })}>
                      <option value="">Select…</option>
                      {(tax?.avatars ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.editorId} onChange={(e) => update(r.key, { editorId: e.target.value })}>
                      <option value="">Unassigned</option>
                      {(editors ?? []).map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.status} onChange={(e) => update(r.key, { status: e.target.value as Row["status"] })}>
                      <option value="planned">🕓 Planned</option>
                      <option value="published">✅ Published</option>
                    </select>
                  </td>
                  <td className="bulk-actions">
                    <button title="Duplicate row" onClick={() => dupRow(r.key)}>⧉</button>
                    <button title="Delete row" onClick={() => delRow(r.key)} disabled={rows.length === 1}>🗑</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="bulk-add" onClick={addRow}>＋ Add Another Post</button>
      <div className="bulk-note">
        <b>ℹ️ Performance metrics</b> — posts are saved as <b>Planned</b>. After publishing, log Views, Likes,
        Comments, Shares, Saves &amp; Accounts Reached on each post.
      </div>
      <div className="formfoot">
        <span style={{ marginRight: "auto", color: "var(--muted)", fontSize: 13, fontWeight: 700 }}>
          {rows.length} post{rows.length === 1 ? "" : "s"} added
        </span>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={saveAll} disabled={saving}>
          {saving ? "Saving…" : "Save All Posts"}
        </button>
      </div>
    </Modal>
  );
}
