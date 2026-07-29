import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, API_BASE } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
import { Modal } from "@/components/modal";
import type { Account, PlatformConnection, IntegrationStatus } from "@/lib/types";

const CALLBACK_ERRORS: Record<string, string> = {
  not_configured: "Instagram isn't configured on the server yet (missing Meta app keys).",
  no_encryption: "Server encryption key isn't set — can't store tokens securely.",
  bad_account: "That account couldn't be found in this org.",
  bad_state: "The connection link expired. Please try again.",
  denied: "You declined the Facebook permission request.",
  no_ig: "No Instagram Business account was found on your Facebook Pages.",
  pick_needed: "Multiple Instagram accounts found — set this channel's handle to match the one you want, then reconnect.",
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

export function IntegrationsPage() {
  const { isAdmin } = useWorkspaces();
  const [params, setParams] = useSearchParams();
  const { data: statusData } = useResource<IntegrationStatus>("/integrations/status");
  const { data: acctData } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const { data: connData, refetch: refetchConns } = useResource<{ connections: PlatformConnection[] }>("/integrations/connections");
  const [syncing, setSyncing] = useState<string | null>(null);

  const igStatus = statusData?.instagram;
  const igReady = igStatus?.ready ?? false;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<Account | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const igAccounts = useMemo(
    () => (acctData?.accounts ?? []).filter((a) => a.platform_key === "instagram"),
    [acctData],
  );
  const connByAccount = useMemo(() => {
    const m = new Map<string, PlatformConnection>();
    for (const c of connData?.connections ?? []) m.set(c.account_id, c);
    return m;
  }, [connData]);

  // Surface the OAuth callback result once, then clean the URL. Depend only on
  // the primitive param values so this can't loop on unstable object identities.
  const connectedParam = params.get("connected");
  const errorParam = params.get("error");
  useEffect(() => {
    if (!connectedParam && !errorParam) return;
    if (connectedParam) {
      toast.success("Instagram connected. Hit “Sync now” to pull your metrics.");
      refetchConns();
    } else if (errorParam) {
      toast.error(CALLBACK_ERRORS[errorParam] ?? "Connection failed.");
    }
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedParam, errorParam]);

  function closeConnect() {
    setConnectFor(null);
    setTokenInput("");
  }

  // Connect via a POST endpoint (system token or per-account pasted token).
  async function connectVia(path: string, body: Record<string, unknown>) {
    if (!connectFor) return;
    setConnecting(connectFor.id);
    try {
      const r = await api<{ handle: string }>(path, { method: "POST", body: JSON.stringify(body) });
      toast.success(`Connected ${r.handle}. Hit “Sync now” to pull metrics.`);
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
      const r = await api<{ updated: number; matched: number; total: number; unmatched: number }>(
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

  return (
    <section className="screen">
      {/* Setup banner */}
      {!igReady && (
        <div className="card pad int-setup">
          <div className="int-setup-ic">🔌</div>
          <div>
            <b>Instagram sync isn't switched on yet.</b>
            <div className="hint" style={{ margin: "4px 0 0" }}>
              Set <code>APP_ENCRYPTION_KEY</code> on the server to paste a token per account,
              and/or a shared <code>META_SYSTEM_TOKEN</code> for one-click connect.
              {statusData && (
                <> Status: per-account tokens {statusData.instagram.pasteToken ? "✅" : "❌"} · system token {statusData.instagram.systemToken ? "✅" : "❌"} · encryption {statusData.instagram.encryption ? "✅" : "❌"}.</>
              )}{" "}
              Add the env var(s) in Render, then reload.
            </div>
          </div>
        </div>
      )}

      <div className="sectitle" style={{ marginTop: igReady ? 6 : 18 }}>
        <span className="dot" />Instagram accounts
        <span className="s">connect a channel, then pull live metrics onto its posts</span>
      </div>

      {igAccounts.length === 0 ? (
        <div className="card pad hint">
          No Instagram accounts yet. Enable Instagram on a channel in <b>Channels</b> first.
        </div>
      ) : (
        <div className="int-list">
          {igAccounts.map((a) => {
            const conn = connByAccount.get(a.id);
            return (
              <div className="card int-card" key={a.id}>
                <div className="int-logo ig">📸</div>
                <div className="int-main">
                  <div className="int-title">
                    {a.channel_name}
                    {conn?.external_name && <span className="int-handle">{conn.external_name}</span>}
                  </div>
                  {conn ? (
                    <div className="int-meta">
                      <span className="int-badge ok">● Connected</span>
                      <span>Last sync {relTime(conn.last_synced_at)}</span>
                      {conn.last_sync_status && <span>· {conn.last_sync_status}</span>}
                    </div>
                  ) : (
                    <div className="int-meta"><span className="int-badge off">○ Not connected</span>
                      <span>{a.handle ? `Pulse handle ${a.handle}` : "No handle set"}</span>
                    </div>
                  )}
                </div>
                <div className="int-actions">
                  {conn ? (
                    <>
                      <button className="btn btn-primary" disabled={syncing === a.id} onClick={() => sync(a.id)}>
                        {syncing === a.id ? "Syncing…" : "🔄 Sync now"}
                      </button>
                      {isAdmin && <button className="btn" onClick={() => disconnect(conn.id)}>Disconnect</button>}
                    </>
                  ) : (
                    <button className="btn btn-primary" disabled={!igReady || !isAdmin || connecting === a.id} onClick={() => setConnectFor(a)}
                      title={!isAdmin ? "Admins only" : !igReady ? "Server not configured" : "Connect this account"}>
                      Connect Instagram
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="demo-note" style={{ marginTop: 18 }}>
        ↪ Syncing matches each post to its real Instagram post by the <b>Link</b> you paste in, then refreshes
        views, reach, likes, comments, shares &amp; saves. Posts without a Link are skipped. Facebook &amp; YouTube are next.
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
