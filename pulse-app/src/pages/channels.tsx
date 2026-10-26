import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { api, ApiError, API_BASE } from "@/lib/api";
import { toast } from "sonner";
import { Modal } from "@/components/modal";
import { compactNum } from "@/lib/date-range";
import { channelTile, initialsOf } from "@/lib/editor-visuals";
import type { Platform, Account, PlatformConnection, IntegrationStatus } from "@/lib/types";
import { SI, Toggle } from "@/pages/settings-ui";

const BRAND: Record<string, { bg: string; label: string; ab: string }> = {
  instagram: { bg: "linear-gradient(135deg,#f9737d,#c13584,#833ab4)", label: "Instagram", ab: "IG" },
  facebook: { bg: "#1877f2", label: "Facebook", ab: "FB" },
  youtube: { bg: "#ff0000", label: "YouTube", ab: "YT" },
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

// Settings › Channels (Pulse Redesign v5): one card per channel, a row per
// platform — whether it's connected and syncing, or its numbers come from the
// Posts page — with Sync / Connect on the row. Admins (or the channels grant)
// rename, add and delete channels, and add or remove a platform. Rendered inside
// the Settings page.
export function ChannelsSection() {
  const { workspaces, active, isAdmin, hasPermission, refresh, switchTo } = useWorkspaces();
  // Admin, or a channels grantee — manage channels & connect integrations.
  const canManage = isAdmin || hasPermission("channels");
  const [params, setParams] = useSearchParams();
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { data: acctData, refetch } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const { data: statusData, refetch: refetchStatus } = useResource<IntegrationStatus>("/integrations/status");
  const { data: connData, refetch: refetchConns } = useResource<{ connections: PlatformConnection[] }>("/integrations/connections");
  const { data: autoSync, refetch: refetchAutoSync } = useResource<{ enabled: boolean; intervalMinutes: number }>("/integrations/auto-sync");
  const [savingAutoSync, setSavingAutoSync] = useState(false);
  const platforms = platData?.platforms ?? [];
  const accounts = acctData?.accounts ?? [];
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // A search box once there are enough channels to need one.
  const [query, setQuery] = useState("");
  // Post counts per channel (surfaces "structure built ahead of content" empties).
  const { data: postData } = useResource<{ posts: { channel_id?: string; is_collab_mirror?: boolean; status?: string }[] }>("/posts?channel=all");

  // Integration state (connect/sync per Instagram account).
  const [syncing, setSyncing] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  type ConnectTarget = { account: Account; platform: "instagram" | "facebook" | "youtube" };
  const [connectFor, setConnectFor] = useState<ConnectTarget | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  // Facebook Page picker: the token can manage several Pages, so the user chooses
  // exactly which one attaches to this channel (fixes a channel showing the wrong
  // Page's data). Pages are fetched without connecting; fbPageId is the selection.
  type FbPage = { pageId: string; pageName: string; followers: number | null };
  const [fbPages, setFbPages] = useState<FbPage[] | null>(null);
  const [fbPageId, setFbPageId] = useState("");
  const [loadingPages, setLoadingPages] = useState(false);
  // Which token the loaded Pages came from — "system" (server token) or "token"
  // (a pasted per-brand token). Keeps the two connect paths from showing each
  // other's Page list when both are available.
  const [fbPagesSource, setFbPagesSource] = useState<"system" | "token" | null>(null);
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
  const connByAccount = useMemo(() => {
    const m = new Map<string, PlatformConnection>();
    for (const c of connData?.connections ?? []) m.set(c.account_id, c);
    return m;
  }, [connData]);
  // channelId -> real (non-mirror) post count, and how many are published.
  const postCountByChannel = useMemo(() => {
    const m = new Map<string, { all: number; pub: number }>();
    for (const p of postData?.posts ?? []) {
      if (p.is_collab_mirror || !p.channel_id) continue;
      const c = m.get(p.channel_id) ?? { all: 0, pub: 0 };
      c.all++;
      if (p.status === "published") c.pub++;
      m.set(p.channel_id, c);
    }
    return m;
  }, [postData]);

  const visibleChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? workspaces.filter((w) => w.name.toLowerCase().includes(q)) : workspaces;
  }, [workspaces, query]);

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
    // first: who'd lose Echo, and what it touches (server/src/routes/workspaces.js)
    let check: { lockedOut: { id: string; name: string }[]; tasks: number; posts: number };
    try {
      check = await api(`/workspaces/${id}/delete-check`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not check that channel.");
      return;
    }
    if (check.lockedOut.length) {
      const who = check.lockedOut.map((p) => p.name);
      toast.error(`Can't delete “${name}”: ${who.length <= 2 ? who.join(" and ") : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`} would lose Echo — it's the only channel ${who.length === 1 ? "they belong" : "they all belong"} to. Give them another channel first (switch to it, then add their login on Team › Roster).`, { duration: 12000 });
      return;
    }
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
    if (!window.confirm(
      `Delete channel “${name}”?\n\n`
      + `• ${check.posts ? `${plural(check.posts, "post")} ${check.posts === 1 ? "is" : "are"} deleted for good` : "It has no posts"}, with its platform links and Instagram connection.\n`
      + `• ${check.tasks ? `${plural(check.tasks, "task")} ${check.tasks === 1 ? "loses its" : "lose their"} brand: ${check.tasks === 1 ? "it stays" : "they stay"}, with no brand` : "No tasks use it"}.\n`
      + `• Nobody loses Echo: everyone in it belongs to another channel too.\n\nThis can't be undone.`,
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

  function closeConnect() { setConnectFor(null); setTokenInput(""); setYtChannelInput(""); setYtKeyInput(""); setReplaceKey(false); setFbPages(null); setFbPageId(""); setFbPagesSource(null); }

  // Save the org-wide auto-sync kill switch / interval (admin only). DB-backed so
  // it takes effect without a deploy.
  async function saveAutoSync(patch: { enabled?: boolean; intervalMinutes?: number }) {
    setSavingAutoSync(true);
    try {
      await api("/integrations/auto-sync", { method: "PATCH", body: JSON.stringify(patch) });
      await refetchAutoSync();
      toast.success("Auto-sync settings saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save auto-sync settings.");
    } finally {
      setSavingAutoSync(false);
    }
  }

  // Fetch the Facebook Pages a token can manage (server system token, or the
  // pasted one) so the user can pick which Page belongs to this channel. Does
  // NOT connect anything — selection happens via the Connect buttons below.
  async function loadFbPages(accountId: string, token?: string) {
    setLoadingPages(true);
    try {
      const r = await api<{ pages: FbPage[] }>("/integrations/facebook/pages", {
        method: "POST",
        body: JSON.stringify({ accountId, ...(token ? { token } : {}) }),
      });
      setFbPages(r.pages);
      setFbPageId(r.pages[0]?.pageId || "");
      setFbPagesSource(token ? "token" : "system");
      if (!r.pages.length) toast.error("This token can't see any Facebook Pages. Check its assigned assets & permissions.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load Facebook Pages.");
    } finally {
      setLoadingPages(false);
    }
  }

  // When the Facebook connect modal opens and a system token exists, load its
  // Pages straight away so the picker is ready.
  useEffect(() => {
    if (connectFor?.platform === "facebook" && fbStatus?.systemToken && fbPages === null && !loadingPages) {
      loadFbPages(connectFor.account.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectFor, fbStatus?.systemToken]);

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
      const r = await api<{ updated?: number; total?: number; unmatched?: number; skipped?: string }>(
        `/integrations/${provider}/sync`,
        { method: "POST", body: JSON.stringify({ accountId }) },
      );
      // A manual click can still be skipped if another sync is already running
      // on this connection (the shared in-flight lock).
      if (r.skipped === "in_progress") {
        toast("A sync is already running for this connection — try again in a moment.");
      } else if (r.skipped) {
        toast("Sync skipped.");
      } else {
        const noun = provider === "youtube" ? "video" : "post";
        toast.success(`Synced ${r.updated} of ${r.total} ${noun}${r.total === 1 ? "" : "s"}${r.unmatched ? ` · ${r.unmatched} not matched to a Link` : ""}.`);
      }
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

  // Auto-sync health chip, derived from the server sync guard's fields. Healthy
  // returns null — the Live/Synced text already conveys it.
  function connHealth(conn: PlatformConnection): { label: string; cls: string } | null {
    if (conn.sync_in_progress) return { label: "Syncing…", cls: "sync" };
    if (conn.last_error_type === "permanent") return { label: "Needs reconnect", cls: "err" };
    // Only a real transient failure shows "Retrying" — a usage-throttle cooldown
    // also bumps consecutive_failures but leaves last_error_type null (healthy).
    if (conn.last_error_type === "transient" && (conn.consecutive_failures ?? 0) > 0) return { label: "Retrying", cls: "warn" };
    return null;
  }

  // One platform on one channel: its connection, when it last synced, and what
  // to do next — or, when the channel isn't on that platform, a way to add it.
  function platformRow(channelId: string, p: Platform) {
    const acc = acctMap[channelId]?.[p.id];
    const brand = BRAND[p.key];
    const label = brand?.label ?? p.name;
    const tile = <i style={{ background: brand?.bg ?? "#71717a" }}>{brand?.ab ?? p.name.slice(0, 2).toUpperCase()}</i>;
    if (!acc) {
      return (
        <div className="st-row" key={p.id}>
          <span className="st-plat off">{tile}<span><b>{label}</b><small>Not on this channel</small></span></span>
          {canManage && <button type="button" className="st-btn sm" onClick={() => toggle(channelId, p)}>{SI.plus}Add {label}</button>}
        </div>
      );
    }
    const prov = (p.key in PLAT_META ? p.key : null) as Prov | null;
    const conn = connByAccount.get(acc.id);
    const meta = prov ? PLAT_META[prov] : null;
    const ready = prov ? platReady(prov) : false;
    const health = conn ? connHealth(conn) : null;
    const removeBtn = canManage && (acc.has_posts ? (
      <button type="button" className="st-icobtn locked" disabled title={`${label} has posts on this channel — move or delete them before removing it`} aria-label={`${label} has posts`}>{SI.lock}</button>
    ) : (
      <button type="button" className="st-icobtn" onClick={() => toggle(channelId, p)} title={`Remove ${label} from this channel`} aria-label={`Remove ${label}`}>{SI.trash}</button>
    ));
    const name = conn?.external_name ?? acc.handle;
    return (
      <div className="st-row" key={p.id}>
        <span className="st-plat">
          {tile}
          <span>
            <b>{label}{name ? <em> {name}</em> : null}</b>
            <small>
              {conn ? (
                <>
                  Synced {relTime(conn.last_synced_at)}
                  {conn.follower_count != null && meta ? ` · ${compactNum(conn.follower_count)} ${meta.unit}` : ""}
                  {health ? <span className={`sync-health ${health.cls}`}> · {health.label}</span> : null}
                </>
              ) : !prov ? "Numbers entered by the team on Posts"
                : ready ? "Numbers entered by the team on Posts — connect to pull them live"
                : prov === "youtube"
                  ? (canManage ? "Add the org YouTube API key on Connect, then connect this channel" : "An admin must add the org YouTube API key first")
                  : "Set the Meta app keys or token on the server first"}
            </small>
          </span>
        </span>
        {conn ? (
          <>
            <span className={"st-chip " + (health?.cls === "err" ? "bad" : health ? "warn" : "good")}>
              {health?.cls === "err" ? "Needs reconnect" : autoSync?.enabled ? "Auto-sync" : "Connected"}
            </span>
            <button type="button" className="st-btn sm" disabled={syncing === acc.id} onClick={() => syncPlatform(acc.id, prov!)}>
              {SI.sync}{syncing === acc.id ? "Syncing…" : "Sync now"}
            </button>
            {canManage && (
              <button type="button" className="st-icobtn" onClick={() => disconnect(conn.id, `${label}${conn.external_name ? " " + conn.external_name : ""}`)}
                title={`Disconnect ${label}`} aria-label={`Disconnect ${label}`}>{SI.unlink}</button>
            )}
          </>
        ) : (
          <>
            <span className="st-chip">Manual</span>
            {prov && (
              <button
                type="button"
                className="st-btn sm"
                /* YouTube's "not ready" is fixable in-app (enter the key), so admins
                   can open it even before a key exists. IG/FB need server config. */
                disabled={(prov === "youtube" ? !canManage : (!ready || !canManage)) || connecting === acc.id}
                title={!canManage ? "Admins only" : (prov !== "youtube" && !ready) ? "Not configured on the server" : `Connect ${label}`}
                onClick={() => setConnectFor({ account: acc, platform: prov })}
              >
                {SI.link}{connecting === acc.id ? "Connecting…" : "Connect"}
              </button>
            )}
            {removeBtn}
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <section className="st-card">
        {autoSync && (
          <div className="st-row" style={{ borderTop: 0 }}>
            <span className="st-label">
              <b>Auto-sync</b>
              <small>
                {autoSync.enabled
                  ? "Live numbers refresh by themselves while someone is signed in with Echo open."
                  : "Off — pull numbers with Sync now on each platform."}
                {!canManage && " Admins can change this."}
              </small>
            </span>
            {autoSync.enabled && (
              <span className="st-pct">
                every
                <input className="st-in" type="number" min={5} max={1440} disabled={!canManage || savingAutoSync} aria-label="Minutes between syncs"
                  key={autoSync.intervalMinutes} defaultValue={autoSync.intervalMinutes}
                  onBlur={(e) => { const v = Number(e.target.value); if (v >= 5 && v <= 1440 && v !== autoSync.intervalMinutes) saveAutoSync({ intervalMinutes: v }); }} />
                min
              </span>
            )}
            <Toggle on={autoSync.enabled} label="Auto-sync" disabled={!canManage || savingAutoSync} onChange={(v) => saveAutoSync({ enabled: v })} />
          </div>
        )}
        {workspaces.length > 6 && (
          <div className="st-row">
            <input className="st-in grow" placeholder="Search channels…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search channels" />
            <span className="st-note">{visibleChannels.length} of {workspaces.length}</span>
          </div>
        )}
        {canManage && (
          <div className="st-foot">
            <input className="st-in grow" placeholder="New channel name" value={newName} disabled={busy}
              onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) addChannel(); }} />
            <button type="button" className="st-btn pri" onClick={addChannel} disabled={busy || !newName.trim()}>{SI.plus}{busy ? "Adding…" : "Add channel"}</button>
          </div>
        )}
      </section>

      {/* YouTube key is org-wide (one key), so surface the gap ONCE here — not on
          every row. It's entered in-app by an admin, no env var. */}
      {ytEnabledAnywhere && !ytStatus?.ready && (
        <section className="st-card">
          <div className="st-row" style={{ borderTop: 0 }}>
            <span className="st-label">
              <b>YouTube isn't set up yet</b>
              <small>
                {canManage
                  ? "One-time, for the whole org: press Connect on any channel's YouTube row and paste your YouTube Data API key. After that, connect any channel by its URL."
                  : "An admin needs to add the org's YouTube API key once (from a channel's YouTube Connect), then channels can be connected."}
              </small>
            </span>
          </div>
        </section>
      )}
      {/* Instagram sync setup notice (only if there are IG accounts but it's not switched on) */}
      {anyIg && !igReady && igStatus && (
        <section className="st-card">
          <div className="st-row" style={{ borderTop: 0 }}>
            <span className="st-label">
              <b>Instagram sync isn't switched on yet</b>
              <small>
                Set <code>APP_ENCRYPTION_KEY</code> on the server to paste a token per account, and/or a shared <code>META_SYSTEM_TOKEN</code> for
                one-click connect. Per-account tokens: {igStatus.pasteToken ? "on" : "off"} · system token: {igStatus.systemToken ? "on" : "off"}. Add them in Render, then reload.
              </small>
            </span>
          </div>
        </section>
      )}

      {accounts.length === 0 && workspaces.length === 0 ? (
        <section className="st-card"><div className="st-empty">Loading…</div></section>
      ) : visibleChannels.length === 0 ? (
        <section className="st-card"><div className="st-empty">No channels match your search.</div></section>
      ) : visibleChannels.map((w) => {
        const posts = postCountByChannel.get(w.id) ?? { all: 0, pub: 0 };
        return (
          <section className="st-card" key={w.id}>
            <div className="st-chhead">
              {w.logo_url
                ? <img className="st-chtile" src={w.logo_url} alt="" />
                : <span className="st-chtile" style={{ backgroundColor: channelTile(w.id) }}>{initialsOf(w.name)}</span>}
              <span className="st-chname">
                {canManage ? (
                  <input defaultValue={w.name} key={w.name} aria-label="Channel name" title="Click to rename"
                    onBlur={(e) => rename(w.id, e.target.value, w.name)}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                ) : <b>{w.name}</b>}
                <small>{posts.all} post{posts.all === 1 ? "" : "s"} · {posts.pub} published</small>
              </span>
              {canManage && workspaces.length > 1 && (
                <button type="button" className="st-btn sm danger" onClick={() => deleteChannel(w.id, w.name)}>{SI.trash}Delete channel</button>
              )}
            </div>
            {platforms.length === 0
              ? <div className="st-row"><span className="st-note">No platforms are set up on the server yet.</span></div>
              : platforms.map((p) => platformRow(w.id, p))}
          </section>
        );
      })}
      <span className="st-note">
        Only published posts count in Analytics. A platform that isn't connected gets its numbers from the Posts page.
        {!canManage && " Read-only — admins can edit channels."}
      </span>

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
        // Facebook Page picker — only shown for Facebook. Lets the user choose
        // exactly which Page attaches, so the channel shows its own Page's data.
        const fbPicker = prov === "facebook" ? (
          loadingPages ? (
            <div className="hint" style={{ display: "block", margin: "8px 0" }}>Loading Facebook Pages…</div>
          ) : fbPages && fbPages.length > 0 ? (
            <div style={{ margin: "10px 0" }}>
              <label className="f">Which Facebook Page?</label>
              <select className="t" value={fbPageId} onChange={(e) => setFbPageId(e.target.value)}>
                {fbPages.map((p) => (
                  <option key={p.pageId} value={p.pageId}>
                    {p.pageName}{p.followers != null ? ` — ${compactNum(p.followers)} followers` : ""}
                  </option>
                ))}
              </select>
              <div className="hint" style={{ display: "block", marginTop: 6 }}>
                Pick the Page that belongs to <b>{connectFor.account.channel_name}</b>. Only Pages this token can access are listed — if the right one is missing, add it to the token's assets in Meta Business settings.
              </div>
            </div>
          ) : fbPages && fbPages.length === 0 ? (
            <div className="hint" style={{ display: "block", margin: "8px 0" }}>
              This token can’t see any Facebook Pages. Check its assigned assets & permissions in Meta Business settings.
            </div>
          ) : null
        ) : null;
        // A Page must be selected only for the path whose Pages are loaded — the
        // system button uses system-token Pages, the paste button uses the
        // pasted token's Pages, so each gates on its own source.
        const fbSystemNeedsPage = prov === "facebook" && fbPagesSource === "system" && fbPages != null && !fbPageId;
        const fbTokenNeedsPage = prov === "facebook" && fbPagesSource === "token" && fbPages != null && !fbPageId;
        return (
          <Modal onClose={closeConnect} title={`Connect ${connectFor.account.channel_name} to ${label}`}>
            <div className="int-modal">
              {st?.systemToken && (
                <>
                  {fbPagesSource === "system" && fbPicker}
                  <button className="btn btn-primary int-block" disabled={connecting === aid || fbSystemNeedsPage}
                    onClick={() => connectVia(`/integrations/${prov}/connect-system`, { accountId: aid, ...(fbPagesSource === "system" && fbPageId ? { pageId: fbPageId } : {}) })}>
                    {connecting === aid ? "Connecting…" : prov === "facebook" ? "⚡ Connect selected Page (system token)" : "⚡ Use server system token (one click)"}
                  </button>
                </>
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
                  </div>
                  {prov === "facebook" && (
                    <>
                      <button className="btn int-block" style={{ marginTop: 12 }}
                        disabled={loadingPages || tokenInput.trim().length < 20}
                        onClick={() => loadFbPages(aid, tokenInput.trim())}>
                        {loadingPages ? "Loading Pages…" : fbPagesSource === "token" ? "Reload this token's Pages" : "Load this token's Pages"}
                      </button>
                      {fbPagesSource === "token" && fbPicker}
                    </>
                  )}
                  <button className="btn btn-primary int-block" style={{ marginTop: 12 }}
                    disabled={connecting === aid || tokenInput.trim().length < 20 || fbTokenNeedsPage}
                    onClick={() => connectVia(`/integrations/${prov}/connect-token`, { accountId: aid, token: tokenInput.trim(), ...(fbPagesSource === "token" && fbPageId ? { pageId: fbPageId } : {}) })}>
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
                  Wrong Page showing on the dashboard? Pick the correct one above and reconnect — it replaces the current Page for this channel.
                </div>
              )}
            </div>
          </Modal>
        );
      })()}
    </>
  );
}
