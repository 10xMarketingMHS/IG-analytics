import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, API_BASE } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useWorkspaces } from "@/lib/workspaces-context";
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

  const igReady = statusData?.instagram.ready ?? false;
  const igMethod = statusData?.instagram.method ?? null;
  const [connecting, setConnecting] = useState<string | null>(null);
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

  async function connect(accountId: string) {
    // System-token path: one API call, no redirect. OAuth path: full-page nav
    // so the auth cookie rides along to the backend.
    if (igMethod === "system") {
      setConnecting(accountId);
      try {
        const r = await api<{ handle: string }>("/integrations/instagram/connect-system", {
          method: "POST",
          body: JSON.stringify({ accountId }),
        });
        toast.success(`Connected ${r.handle}. Hit “Sync now” to pull metrics.`);
        refetchConns();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't connect.");
      } finally {
        setConnecting(null);
      }
      return;
    }
    window.location.href = `${API_BASE}/integrations/instagram/connect?accountId=${accountId}`;
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
              Simplest: set a <code>META_SYSTEM_TOKEN</code> (a long-lived Meta System User
              token) on the server — then connect with one click, no expiry.
              Alternatively use the OAuth app route (<code>META_APP_ID</code>, <code>META_APP_SECRET</code>,
              <code>APP_BASE_URL</code>, <code>APP_ENCRYPTION_KEY</code>).
              {statusData && (
                <> Status: system token {statusData.instagram.systemToken ? "✅" : "❌"} · OAuth app {statusData.instagram.configured ? "✅" : "❌"} · encryption {statusData.instagram.encryption ? "✅" : "❌"}.</>
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
                    <button className="btn btn-primary" disabled={!igReady || !isAdmin || connecting === a.id} onClick={() => connect(a.id)}
                      title={!isAdmin ? "Admins only" : !igReady ? "Server not configured" : "Connect this account"}>
                      {connecting === a.id ? "Connecting…" : "Connect Instagram"}
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
    </section>
  );
}
