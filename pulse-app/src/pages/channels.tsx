import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { api, ApiError, API_BASE } from "@/lib/api";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { MultiSelect, type Opt } from "@/components/multi-select";
import { compactNum } from "@/lib/date-range";
import type { Platform, Account, PlatformConnection, IntegrationStatus } from "@/lib/types";

// Channel-status filters (scale: narrow a long list to what needs action).
const STATUS_FILTERS: Opt[] = [
  { value: "ig_connected", label: "Instagram connected" },
  { value: "ig_unlinked", label: "Instagram not connected" },
  { value: "yt_live", label: "YouTube synced" },
  { value: "empty", label: "No posts yet" },
];

const BRAND: Record<string, { bg: string; label: string; icon: string }> = {
  instagram: { bg: "linear-gradient(135deg,#f9737d,#c13584,#833ab4)", label: "Instagram", icon: "📸" },
  facebook: { bg: "#1877f2", label: "Facebook", icon: "👍" },
  youtube: { bg: "#ff0000", label: "YouTube", icon: "▶️" },
};

const CALLBACK_ERRORS: Record<string, string> = {
  not_configured: "Instagram isn't configured on the server yet (missing Meta app keys).",
  no_encryption: "Server encryption key isn't set — can't store tokens securely.",
  bad_account: "That account couldn't be found in this org.",
  bad_state: "The connection link expired. Please try again.",
  denied: "You declined the Facebook permission request.",
  no_ig: "No Instagram Business account was found on your Facebook Pages.",
  pick_needed: "Multiple Instagram accounts found — set this channel's handle to match, then reconnect.",
  exchange_failed: "Facebook rejected the connection. Check the app setup and try again.",
};

function relTime(iso: string | null) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ChannelsPage() {
  const { workspaces, active, isAdmin, refresh, switchTo } = useWorkspaces();
  const [params, setParams] = useSearchParams();
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { data: acctData, refetch } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const { data: statusData, refetch: refetchStatus } = useResource<IntegrationStatus>("/integrations/status");
  const { data: connData, refetch: refetchConns } = useResource<{ connections: PlatformConnection[] }>("/integrations/connections");
  const platforms = platData?.platforms ?? [];
  const accounts = acctData?.accounts ?? [];
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // Table view: search, status filter, and which row is expanded for management.
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  // Post counts per channel (surfaces "structure built ahead of content" empties).
  const { data: postData } = useResource<{ posts: { channel_id?: string; is_collab_mirror?: boolean }[] }>("/posts?channel=all");

  // Integration state (connect/sync per Instagram account).
  const [syncing, setSyncing] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  type ConnectTarget = { account: Account; platform: "instagram" | "facebook" | "youtube" };
  const [connectFor, setConnectFor] = useState<ConnectTarget | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [ytChannelInput, setYtChannelInput] = useState("");
  const [ytKeyInput, setYtKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [replaceKey, setReplaceKey] = useState(false); // force the key step even if one exists
  const igStatus = statusData?.instagram;
  const igReady = igStatus?.ready ?? false;
  const fbStatus = statusData?.facebook;
  const fbReady = fbStatus?.ready ?? false;
  const ytStatus = statusData?.youtube;
  const ytEnabledAnywhere = accounts.some((a) => a.platform_key === "youtube");

  // channelId -> platformId -> the full account row (so a pill can read has_posts).
  const acctMap = useMemo(() => {
    const m: Record<string, Record<string, Account>> = {};
    for (const a of accounts) (m[a.channel_id] ||= {})[a.platform_id] = a;
    return m;
  }, [accounts]);
  // channelId -> the channel's Instagram account (the syncable one).
  const igAccountByChannel = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of accounts) if (a.platform_key === "instagram") m.set(a.channel_id, a);
    return m;
  }, [accounts]);
  // channelId -> the channel's Facebook account.
  const fbAccountByChannel = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of accounts) if (a.platform_key === "facebook") m.set(a.channel_id, a);
    return m;
  }, [accounts]);
  // channelId -> the channel's YouTube account.
  const ytAccountByChannel = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of accounts) if (a.platform_key === "youtube") m.set(a.channel_id, a);
    return m;
  }, [accounts]);
  const connByAccount = useMemo(() => {
    const m = new Map<string, PlatformConnection>();
    for (const c of connData?.connections ?? []) m.set(c.account_id, c);
    return m;
  }, [connData]);
  // channelId -> real (non-mirror) post count.
  const postCountByChannel = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of postData?.posts ?? []) {
      if (p.is_collab_mirror || !p.channel_id) continue;
      m.set(p.channel_id, (m.get(p.channel_id) ?? 0) + 1);
    }
    return m;
  }, [postData]);

  // Search + status filter applied to the channel list (OR within the filter).
  const visibleChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workspaces.filter((w) => {
      if (q && !w.name.toLowerCase().includes(q)) return false;
      if (statuses.size === 0) return true;
      const igAcc = igAccountByChannel.get(w.id);
      const conn = igAcc ? connByAccount.get(igAcc.id) : undefined;
      const ytAcc = ytAccountByChannel.get(w.id);
      const posts = postCountByChannel.get(w.id) ?? 0;
      const flags: Record<string, boolean> = {
        ig_connected: !!conn,
        ig_unlinked: !!igAcc && !conn,
        yt_live: !!(ytAcc && connByAccount.get(ytAcc.id)),
        empty: posts === 0,
      };
      return [...statuses].some((s) => flags[s]);
    });
  }, [workspaces, query, statuses, igAccountByChannel, connByAccount, ytAccountByChannel, postCountByChannel]);

  // Surface the OAuth callback result once (redirected here), then clean the URL.
  const connectedParam = params.get("connected");
  const errorParam = params.get("error");
  const facebookParam = params.get("facebook");
  useEffect(() => {
    if (!connectedParam && !errorParam) return;
    if (connectedParam) {
      toast.success("Instagram connected. Hit “Sync” to pull your metrics.");
      // Shared Meta: the same auth connected a Facebook Page too — surface it.
      if (facebookParam) toast.success(`Facebook Page “${facebookParam}” connected too.`);
      refetchConns();
    } else if (errorParam) {
      toast.error(CALLBACK_ERRORS[errorParam] ?? "Connection failed.");
    }
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedParam, errorParam]);

  async function addChannel() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api("/workspaces", { method: "POST", body: JSON.stringify({ name }) });
      setNewName("");
      await refresh();
      await refetch();
      toast.success(`Channel “${name}” added — Instagram enabled to start.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not add channel.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(channelId: string, p: Platform) {
    const existing = acctMap[channelId]?.[p.id]?.id;
    try {
      if (existing) await api(`/accounts/${existing}`, { method: "DELETE" });
      else await api("/accounts", { method: "POST", body: JSON.stringify({ channelId, platformId: p.id }) });
      await refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update platform.");
    }
  }

  async function deleteChannel(id: string, name: string) {
    if (!window.confirm(
      `Delete channel “${name}”?\n\nThis permanently removes its posts, platform links, and Instagram connection. Your team and other channels are kept, and tasks stay (just un-linked from this channel).\n\nThis can't be undone.`,
    )) return;
    try {
      await api(`/workspaces/${id}`, { method: "DELETE" });
      toast.success(`Channel “${name}” deleted.`);
      // If we just deleted the active channel, switch to another (reloads).
      if (active?.id === id) {
        const other = workspaces.find((w) => w.id !== id);
        if (other) { switchTo(other.id); return; }
      }
      await refresh();
      await refetch();
      refetchConns();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete channel.");
    }
  }

  async function rename(id: string, next: string, orig: string) {
    const name = next.trim();
    if (!name || name === orig) return;
    try {
      await api(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await refresh();
      toast.success("Channel renamed.");
    } catch {
      toast.error("Could not rename channel.");
    }
  }

  function closeConnect() { setConnectFor(null); setTokenInput(""); setYtChannelInput(""); setYtKeyInput(""); setReplaceKey(false); }

  // Admin saves the org's YouTube API key (validated server-side before storing).
  async function saveYoutubeKey() {
    const key = ytKeyInput.trim();
    if (key.length < 10) return;
    setSavingKey(true);
    try {
      await api("/integrations/youtube/key", { method: "POST", body: JSON.stringify({ key }) });
      toast.success("YouTube API key saved — you can now connect channels.");
      setYtKeyInput("");
      setReplaceKey(false);
      await refetchStatus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the key.");
    } finally {
      setSavingKey(false);
    }
  }

  // Instagram / Facebook connect (Meta system-token, pasted-token, or OAuth).
  async function connectVia(path: string, body: Record<string, unknown>) {
    if (!connectFor) return;
    setConnecting(connectFor.account.id);
    try {
      const r = await api<{ handle?: string; page?: string; facebookPage?: string | null }>(path, { method: "POST", body: JSON.stringify(body) });
      toast.success(`Connected ${r.handle ?? r.page ?? "account"}. Hit “Sync” to pull metrics.`);
      if (r.facebookPage) toast.success(`Facebook Page “${r.facebookPage}” connected too.`);
      closeConnect();
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't connect.");
    } finally {
      setConnecting(null);
    }
  }

  // YouTube connect (Y-A): resolve a channel URL/handle via the org API key.
  async function connectYoutube() {
    if (!connectFor) return;
    const channel = ytChannelInput.trim();
    if (!channel) return;
    setConnecting(connectFor.account.id);
    try {
      const r = await api<{ channel: string }>("/integrations/youtube/connect", { method: "POST", body: JSON.stringify({ accountId: connectFor.account.id, channel }) });
      toast.success(`Connected YouTube “${r.channel}”. Hit “Sync” to pull stats.`);
      closeConnect();
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't connect — check the channel URL/handle.");
    } finally {
      setConnecting(null);
    }
  }

  // One sync path for all three platforms (each posts to its own endpoint).
  async function syncPlatform(accountId: string, provider: "instagram" | "facebook" | "youtube") {
    setSyncing(accountId);
    try {
      const r = await api<{ updated: number; total: number; unmatched: number }>(
        `/integrations/${provider}/sync`,
        { method: "POST", body: JSON.stringify({ accountId }) },
      );
      const noun = provider === "youtube" ? "video" : "post";
      toast.success(`Synced ${r.updated} of ${r.total} ${noun}${r.total === 1 ? "" : "s"}${r.unmatched ? ` · ${r.unmatched} not matched to a Link` : ""}.`);
      await refetch();
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(null);
    }
  }

  async function disconnect(id: string, label: string) {
    if (!confirm(`Disconnect ${label}? Your posts keep their metrics.`)) return;
    try {
      await api(`/integrations/connections/${id}`, { method: "DELETE" });
      toast.success("Disconnected.");
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect.");
    }
  }

  const anyIg = accounts.some((a) => a.platform_key === "instagram");

  const PLAT_META = {
    instagram: { icon: "📸", label: "Instagram", unit: "followers" },
    facebook: { icon: "👍", label: "Facebook", unit: "followers" },
    youtube: { icon: "▶️", label: "YouTube", unit: "subs" },
  } as const;
  type Prov = keyof typeof PLAT_META;
  const platReady = (p: Prov) => (p === "instagram" ? igReady : p === "facebook" ? fbReady : (ytStatus?.ready ?? false));

  // Compact per-platform status for a table cell.
  function statusCell(acc: Account | undefined) {
    if (!acc) return <span className="st dim">—</span>;
    const conn = connByAccount.get(acc.id);
    if (conn) return conn.last_synced_at
      ? <span className="st ok">● Live · {relTime(conn.last_synced_at)}</span>
      : <span className="st ok">● Connected</span>;
    return <span className="st off">○ Connect</span>;
  }

  // The symmetric connection block (Connect/Disconnect · name · status · synced ·
  // Sync) rendered identically for Instagram, Facebook, and YouTube.
  function platformBlock(acc: Account | undefined, p: Prov) {
    if (!acc) return null;
    const conn = connByAccount.get(acc.id);
    const meta = PLAT_META[p];
    const ready = platReady(p);
    return (
      <div className="chan-int" key={p}>
        <span className="chan-int-logo">{meta.icon}</span>
        {conn ? (
          <>
            <div className="chan-int-info">
              <span className="int-badge ok">
                ● {conn.external_name ?? meta.label}
                {conn.follower_count != null ? ` · ${compactNum(conn.follower_count)} ${meta.unit}` : ""}
              </span>
              <span className="chan-int-sub">Synced {relTime(conn.last_synced_at)}{conn.last_sync_status ? ` · ${conn.last_sync_status}` : ""}</span>
            </div>
            <div className="chan-int-act">
              <button className="btn btn-primary btn-sm" disabled={syncing === acc.id} onClick={() => syncPlatform(acc.id, p)}>
                {syncing === acc.id ? "Syncing…" : "🔄 Sync"}
              </button>
              {isAdmin && <button className="btn btn-sm" onClick={() => disconnect(conn.id, `${meta.label}${conn.external_name ? " " + conn.external_name : ""}`)}>Disconnect</button>}
            </div>
          </>
        ) : (
          <>
            <div className="chan-int-info">
              <span className="int-badge off">○ {meta.label} not connected</span>
              <span className="chan-int-sub">
                {ready
                  ? "Connect to pull live metrics onto this channel's posts"
                  : p === "youtube"
                    ? (isAdmin ? "Add the org YouTube API key here, then connect this channel" : "An admin must add the org YouTube API key first")
                    : "Set the Meta app keys / token on the server first"}
              </span>
            </div>
            <button
              className="btn btn-primary btn-sm"
              /* YouTube's "not ready" is fixable in-app (enter the key), so admins
                 can open it even before a key exists. IG/FB need server config. */
              disabled={(p === "youtube" ? !isAdmin : (!ready || !isAdmin)) || connecting === acc.id}
              title={!isAdmin ? "Admins only" : (p !== "youtube" && !ready) ? "Not configured on the server" : `Connect ${meta.label}`}
              onClick={() => setConnectFor({ account: acc, platform: p })}
            >
              {connecting === acc.id ? "Connecting…" : "Connect"}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="screen">
      <div className="hint" style={{ marginBottom: 16 }}>
        🌐 Add brand channels, choose which platforms each is on, and connect Instagram or YouTube to pull live metrics — all in one place.
        {!isAdmin && <span style={{ color: "var(--amber)", marginLeft: 6 }}>· Read-only (admins can edit).</span>}
      </div>

      {/* YouTube key is org-wide (one key), so surface the gap ONCE here — not as
          a chip on every row. It's now entered in-app by an admin, no env var. */}
      {ytEnabledAnywhere && !ytStatus?.ready && (
        <div className="card pad int-setup" style={{ marginBottom: 16 }}>
          <div className="int-setup-ic">▶️</div>
          <div>
            <b>YouTube isn't set up yet.</b>
            <div className="hint" style={{ margin: "4px 0 0" }}>
              {isAdmin
                ? "One-time, org-wide: click Connect on any channel's YouTube column and paste your YouTube Data API key. After that, connect any number of channels by URL — no server config."
                : "An admin needs to add the org's YouTube API key once (from a channel's YouTube Connect), then channels can be connected."}
            </div>
          </div>
        </div>
      )}

      {/* Instagram sync setup notice (only if there are IG accounts but it's not switched on) */}
      {anyIg && !igReady && igStatus && (
        <div className="card pad int-setup" style={{ marginBottom: 16 }}>
          <div className="int-setup-ic">🔌</div>
          <div>
            <b>Instagram sync isn't switched on yet.</b>
            <div className="hint" style={{ margin: "4px 0 0" }}>
              Set <code>APP_ENCRYPTION_KEY</code> on the server to paste a token per account, and/or a shared
              <code>META_SYSTEM_TOKEN</code> for one-click connect. Status: per-account tokens {igStatus.pasteToken ? "✅" : "❌"} ·
              system token {igStatus.systemToken ? "✅" : "❌"}. Add the env var(s) in Render, then reload.
            </div>
          </div>
        </div>
      )}

      {/* Toolbar: search + status filter + count + add channel */}
      <div className="chan-toolbar">
        <div className="search">
          <span aria-hidden>🔎</span>
          <input placeholder="Search channels…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <MultiSelect
          label="Status"
          options={STATUS_FILTERS}
          selected={statuses}
          onToggle={(v) => setStatuses((s) => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n; })}
        />
        <span className="chan-total">{visibleChannels.length} channel{visibleChannels.length === 1 ? "" : "s"}</span>
        {isAdmin && (
          <div className="chan-add">
            <input
              className="t"
              placeholder="New channel name…"
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) addChannel(); }}
            />
            <button className="btn btn-primary" onClick={addChannel} disabled={busy || !newName.trim()}>
              {busy ? "Adding…" : "＋ Add"}
            </button>
          </div>
        )}
      </div>

      <div className="card pad chan-tablewrap">
        <table className="tbl chan-tbl">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Instagram</th>
              <th>Facebook</th>
              <th>YouTube</th>
              <th className="num">Posts</th>
              <th aria-label="expand" />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && workspaces.length === 0 ? (
              <tr><td colSpan={6} className="chan-emptyrow">Loading…</td></tr>
            ) : visibleChannels.length === 0 ? (
              <tr><td colSpan={6} className="chan-emptyrow">No channels match your search or filters.</td></tr>
            ) : (
              visibleChannels.map((w) => {
                const igAcc = igAccountByChannel.get(w.id);
                const fbAcc = fbAccountByChannel.get(w.id);
                const ytAcc = ytAccountByChannel.get(w.id);
                const posts = postCountByChannel.get(w.id) ?? 0;
                const open = expanded === w.id;
                return (
                  <Fragment key={w.id}>
                    <tr className={"clickrow chan-row" + (open ? " open" : "")} onClick={() => setExpanded(open ? null : w.id)}>
                      <td><b>{w.name}</b></td>
                      <td>{statusCell(igAcc)}</td>
                      <td>{statusCell(fbAcc)}</td>
                      <td>{statusCell(ytAcc)}</td>
                      <td className="num">{posts}</td>
                      <td className="chev">{open ? "▾" : "▸"}</td>
                    </tr>
                    {open && (
                      <tr className="exp-row">
                        <td className="exp-cell" colSpan={6}>
                          <div className="exp-inner" onClick={(e) => e.stopPropagation()}>
                            {isAdmin && (
                              <div className="exp-head">
                                <input
                                  className="chan-name"
                                  defaultValue={w.name}
                                  onBlur={(e) => rename(w.id, e.target.value, w.name)}
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                />
                                {workspaces.length > 1 && (
                                  <button className="btn btn-sm chan-del" title="Delete channel" onClick={() => deleteChannel(w.id, w.name)}>🗑 Delete channel</button>
                                )}
                              </div>
                            )}

                            <div className="exp-plats">
                              {platforms.map((p) => {
                                const acct = acctMap[w.id]?.[p.id];
                                const pon = !!acct;
                                const locked = pon && !!acct?.has_posts;
                                const brand = BRAND[p.key];
                                return (
                                  <button
                                    key={p.id}
                                    className={"chan-chip" + (pon ? " on" : "") + (locked ? " locked" : "")}
                                    style={pon ? { background: brand?.bg } : undefined}
                                    onClick={() => isAdmin && !locked && toggle(w.id, p)}
                                    disabled={!isAdmin || locked}
                                    title={locked
                                      ? `${brand?.label ?? p.name} has posts on this channel — remove them before disabling`
                                      : pon ? `Disable ${brand?.label ?? p.name}` : `Enable ${brand?.label ?? p.name}`}
                                  >
                                    <span>{brand?.icon ?? "📱"}</span>
                                    {brand?.label ?? p.name}
                                    <span className="chan-mark">{locked ? "🔒" : pon ? "✓" : "+"}</span>
                                  </button>
                                );
                              })}
                            </div>

                            {/* Symmetric per-platform connection blocks (IG / FB / YT) */}
                            <div className="exp-ints">
                              {platformBlock(igAcc, "instagram")}
                              {platformBlock(fbAcc, "facebook")}
                              {platformBlock(ytAcc, "youtube")}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {connectFor && connectFor.platform === "youtube" && (
        <Modal onClose={closeConnect} title={`Connect ${connectFor.account.channel_name} to YouTube`}>
          <div className="int-modal">
            {(!ytStatus?.ready || replaceKey) ? (
              /* Step 1 — org API key (admin, one-time). Separate from channel connect. */
              <>
                <label className="f">YouTube Data API key {ytStatus?.ready ? "(replace)" : "(one-time · org-wide)"}</label>
                {ytStatus && !ytStatus.encryption ? (
                  <div className="hint" style={{ display: "block" }}>
                    Server encryption key isn't set (<code>APP_ENCRYPTION_KEY</code>) — can't store the key securely. Set it on the server, then reload.
                  </div>
                ) : (
                  <>
                    <input
                      className="t"
                      placeholder="Paste your YouTube Data API v3 key…"
                      value={ytKeyInput}
                      onChange={(e) => setYtKeyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveYoutubeKey(); }}
                      style={{ wordBreak: "break-all" }}
                    />
                    <div className="hint" style={{ display: "block", marginTop: 6 }}>
                      Stored <b>encrypted</b>. In Google Cloud: enable <b>YouTube Data API v3</b> → Credentials → <b>API key</b>. It's validated before saving — a bad key is rejected, never stored. Set once for the whole org.
                    </div>
                    <button className="btn btn-primary int-block" style={{ marginTop: 12 }} disabled={savingKey || ytKeyInput.trim().length < 10} onClick={saveYoutubeKey}>
                      {savingKey ? "Validating…" : "Save API key"}
                    </button>
                    {ytStatus?.ready && replaceKey && (
                      <button className="btn int-block" style={{ marginTop: 8 }} onClick={() => { setReplaceKey(false); setYtKeyInput(""); }}>Cancel</button>
                    )}
                  </>
                )}
              </>
            ) : (
              /* Step 2 — connect a channel (key already configured). */
              <>
                <label className="f">YouTube channel URL or @handle</label>
                <input
                  className="t"
                  placeholder="https://youtube.com/@yourchannel  ·  @yourchannel"
                  value={ytChannelInput}
                  onChange={(e) => setYtChannelInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") connectYoutube(); }}
                />
                <div className="hint" style={{ display: "block", marginTop: 6 }}>
                  Resolved via the org's saved API key — an unrecognised channel is rejected, never connected to nothing.
                  <button className="linkbtn" style={{ marginLeft: 6 }} onClick={() => setReplaceKey(true)}>Replace API key</button>
                </div>
                <button className="btn btn-primary int-block" style={{ marginTop: 12 }} disabled={connecting === connectFor.account.id || ytChannelInput.trim().length < 2} onClick={connectYoutube}>
                  {connecting === connectFor.account.id ? "Resolving…" : "Resolve & connect"}
                </button>
              </>
            )}
          </div>
        </Modal>
      )}

      {connectFor && connectFor.platform !== "youtube" && (() => {
        const prov = connectFor.platform; // "instagram" | "facebook"
        const st = prov === "instagram" ? igStatus : fbStatus;
        const label = prov === "instagram" ? "Instagram" : "Facebook";
        const aid = connectFor.account.id;
        return (
          <Modal onClose={closeConnect} title={`Connect ${connectFor.account.channel_name} to ${label}`}>
            <div className="int-modal">
              {st?.systemToken && (
                <button className="btn btn-primary int-block" disabled={connecting === aid}
                  onClick={() => connectVia(`/integrations/${prov}/connect-system`, { accountId: aid })}>
                  {connecting === aid ? "Connecting…" : "⚡ Use server system token (one click)"}
                </button>
              )}
              {st?.pasteToken ? (
                <>
                  {st?.systemToken && <div className="int-or">or paste this account's own token</div>}
                  <label className="f">{label} access token</label>
                  <textarea
                    className="t" rows={4}
                    placeholder="Paste the System User / access token…"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    style={{ resize: "vertical", wordBreak: "break-all" }}
                  />
                  <div className="hint" style={{ display: "block", marginTop: 6 }}>
                    Stored <b>encrypted</b>. Use a token whose assets include this channel's {prov === "instagram" ? "Page + Instagram" : "Facebook Page"}.
                    If it sees several, set this channel's handle to match first.
                  </div>
                  <button className="btn btn-primary int-block" style={{ marginTop: 12 }}
                    disabled={connecting === aid || tokenInput.trim().length < 20}
                    onClick={() => connectVia(`/integrations/${prov}/connect-token`, { accountId: aid, token: tokenInput.trim() })}>
                    {connecting === aid ? "Connecting…" : "Connect with this token"}
                  </button>
                </>
              ) : (
                <div className="hint" style={{ display: "block" }}>
                  To paste a per-account token, set <code>APP_ENCRYPTION_KEY</code> on the server (Render → Environment), then reload.
                </div>
              )}
              {prov === "instagram" && igStatus?.configured && igStatus?.encryption && (
                <button className="btn int-block" style={{ marginTop: 14 }} onClick={() => { window.location.href = `${API_BASE}/integrations/instagram/connect?accountId=${aid}`; }}>
                  Connect via Facebook OAuth instead
                </button>
              )}
              {prov === "facebook" && (
                <div className="hint" style={{ display: "block", marginTop: 10 }}>
                  Tip: connecting <b>Instagram</b> via Meta also connects its linked Facebook Page automatically.
                </div>
              )}
            </div>
          </Modal>
        );
      })()}
    </section>
  );
}
