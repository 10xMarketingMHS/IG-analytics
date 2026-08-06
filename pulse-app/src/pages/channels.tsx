import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { api, ApiError, API_BASE } from "@/lib/api";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import type { Platform, Account, PlatformConnection, IntegrationStatus } from "@/lib/types";

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
  const { data: statusData } = useResource<IntegrationStatus>("/integrations/status");
  const { data: connData, refetch: refetchConns } = useResource<{ connections: PlatformConnection[] }>("/integrations/connections");
  const platforms = platData?.platforms ?? [];
  const accounts = acctData?.accounts ?? [];
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Integration state (connect/sync per Instagram account).
  const [syncing, setSyncing] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<Account | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const igStatus = statusData?.instagram;
  const igReady = igStatus?.ready ?? false;

  // channelId -> platformId -> accountId
  const acctMap = useMemo(() => {
    const m: Record<string, Record<string, string>> = {};
    for (const a of accounts) (m[a.channel_id] ||= {})[a.platform_id] = a.id;
    return m;
  }, [accounts]);
  // channelId -> the channel's Instagram account (the syncable one).
  const igAccountByChannel = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of accounts) if (a.platform_key === "instagram") m.set(a.channel_id, a);
    return m;
  }, [accounts]);
  const connByAccount = useMemo(() => {
    const m = new Map<string, PlatformConnection>();
    for (const c of connData?.connections ?? []) m.set(c.account_id, c);
    return m;
  }, [connData]);

  // Surface the OAuth callback result once (redirected here), then clean the URL.
  const connectedParam = params.get("connected");
  const errorParam = params.get("error");
  useEffect(() => {
    if (!connectedParam && !errorParam) return;
    if (connectedParam) {
      toast.success("Instagram connected. Hit “Sync” to pull your metrics.");
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
    const existing = acctMap[channelId]?.[p.id];
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

  function closeConnect() { setConnectFor(null); setTokenInput(""); }

  async function connectVia(path: string, body: Record<string, unknown>) {
    if (!connectFor) return;
    setConnecting(connectFor.id);
    try {
      const r = await api<{ handle: string }>(path, { method: "POST", body: JSON.stringify(body) });
      toast.success(`Connected ${r.handle}. Hit “Sync” to pull metrics.`);
      closeConnect();
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't connect.");
    } finally {
      setConnecting(null);
    }
  }

  async function sync(accountId: string) {
    setSyncing(accountId);
    try {
      const r = await api<{ updated: number; total: number; unmatched: number }>(
        "/integrations/instagram/sync",
        { method: "POST", body: JSON.stringify({ accountId }) },
      );
      toast.success(`Synced ${r.updated} of ${r.total} post${r.total === 1 ? "" : "s"}${r.unmatched ? ` · ${r.unmatched} not matched to a Link` : ""}.`);
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(null);
    }
  }

  async function disconnect(id: string) {
    if (!confirm("Disconnect this Instagram account? Your posts keep their metrics.")) return;
    try {
      await api(`/integrations/connections/${id}`, { method: "DELETE" });
      toast.success("Disconnected.");
      refetchConns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect.");
    }
  }

  const anyIg = accounts.some((a) => a.platform_key === "instagram");

  return (
    <section className="screen">
      <div className="hint" style={{ marginBottom: 16 }}>
        🌐 Add brand channels, choose which platforms each is on, and connect Instagram to pull live metrics — all in one place.
        {!isAdmin && <span style={{ color: "var(--amber)", marginLeft: 6 }}>· Read-only (admins can edit).</span>}
      </div>

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

      {isAdmin && (
        <div className="chan-add">
          <input
            className="t"
            placeholder="New channel name — e.g. My New Brand"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addChannel(); }}
          />
          <button className="btn btn-primary" onClick={addChannel} disabled={busy || !newName.trim()}>
            {busy ? "Adding…" : "＋ Add Channel"}
          </button>
        </div>
      )}

      <div className="chan-list">
        {workspaces.map((w) => {
          const enabledCount = platforms.filter((p) => acctMap[w.id]?.[p.id]).length;
          const igAcc = igAccountByChannel.get(w.id);
          const conn = igAcc ? connByAccount.get(igAcc.id) : undefined;
          return (
            <div className="chan-card" key={w.id}>
              <div className="chan-top">
                <input
                  className="chan-name"
                  defaultValue={w.name}
                  disabled={!isAdmin}
                  onBlur={(e) => rename(w.id, e.target.value, w.name)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
                <span className="chan-count">{enabledCount} platform{enabledCount === 1 ? "" : "s"}</span>
                {isAdmin && workspaces.length > 1 && (
                  <button className="chan-del" title="Delete channel" onClick={() => deleteChannel(w.id, w.name)}>🗑</button>
                )}
              </div>
              <div className="chan-plats">
                {platforms.map((p) => {
                  const on = !!acctMap[w.id]?.[p.id];
                  const brand = BRAND[p.key];
                  return (
                    <button
                      key={p.id}
                      className={"chan-chip" + (on ? " on" : "")}
                      style={on ? { background: brand?.bg } : undefined}
                      onClick={() => isAdmin && toggle(w.id, p)}
                      disabled={!isAdmin}
                      title={on ? `Disable ${brand?.label ?? p.name}` : `Enable ${brand?.label ?? p.name}`}
                    >
                      <span>{brand?.icon ?? "📱"}</span>
                      {brand?.label ?? p.name}
                      <span className="chan-mark">{on ? "✓" : "+"}</span>
                    </button>
                  );
                })}
              </div>

              {/* Instagram integration — connect / sync, right inside the channel */}
              {igAcc && (
                <div className="chan-int">
                  <span className="chan-int-logo">📸</span>
                  {conn ? (
                    <>
                      <div className="chan-int-info">
                        <span className="int-badge ok">● {conn.external_name ?? "Connected"}</span>
                        <span className="chan-int-sub">Synced {relTime(conn.last_synced_at)}{conn.last_sync_status ? ` · ${conn.last_sync_status}` : ""}</span>
                      </div>
                      <div className="chan-int-act">
                        <button className="btn btn-primary btn-sm" disabled={syncing === igAcc.id} onClick={() => sync(igAcc.id)}>
                          {syncing === igAcc.id ? "Syncing…" : "🔄 Sync"}
                        </button>
                        {isAdmin && <button className="btn btn-sm" onClick={() => disconnect(conn.id)}>Disconnect</button>}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="chan-int-info">
                        <span className="int-badge off">○ Instagram not connected</span>
                        <span className="chan-int-sub">Connect to pull live metrics onto this channel's posts</span>
                      </div>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!igReady || !isAdmin || connecting === igAcc.id}
                        title={!isAdmin ? "Admins only" : !igReady ? "Instagram sync not configured on the server" : "Connect Instagram"}
                        onClick={() => setConnectFor(igAcc)}
                      >
                        {connecting === igAcc.id ? "Connecting…" : "Connect"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {connectFor && (
        <Modal onClose={closeConnect} title={`Connect ${connectFor.channel_name} to Instagram`}>
          <div className="int-modal">
            {igStatus?.systemToken && (
              <button
                className="btn btn-primary int-block"
                disabled={connecting === connectFor.id}
                onClick={() => connectVia("/integrations/instagram/connect-system", { accountId: connectFor.id })}
              >
                {connecting === connectFor.id ? "Connecting…" : "⚡ Use server system token (one click)"}
              </button>
            )}

            {igStatus?.pasteToken ? (
              <>
                {igStatus?.systemToken && <div className="int-or">or paste this account's own token</div>}
                <label className="f">Instagram access token</label>
                <textarea
                  className="t"
                  rows={4}
                  placeholder="Paste the System User / access token for this account…"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  style={{ resize: "vertical", wordBreak: "break-all" }}
                />
                <div className="hint" style={{ display: "block", marginTop: 6 }}>
                  Stored <b>encrypted</b> on the server. Use a token whose assigned assets include this account's
                  Page + Instagram. If the token sees several accounts, set this channel's handle to match first.
                </div>
                <button
                  className="btn btn-primary int-block"
                  style={{ marginTop: 12 }}
                  disabled={connecting === connectFor.id || tokenInput.trim().length < 20}
                  onClick={() => connectVia("/integrations/instagram/connect-token", { accountId: connectFor.id, token: tokenInput.trim() })}
                >
                  {connecting === connectFor.id ? "Connecting…" : "Connect with this token"}
                </button>
              </>
            ) : (
              <div className="hint" style={{ display: "block" }}>
                To paste a per-account token, set <code>APP_ENCRYPTION_KEY</code> on the server (Render → Environment), then reload.
              </div>
            )}

            {igStatus?.configured && igStatus?.encryption && (
              <button className="btn int-block" style={{ marginTop: 14 }} onClick={() => { window.location.href = `${API_BASE}/integrations/instagram/connect?accountId=${connectFor.id}`; }}>
                Connect via Facebook instead
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
