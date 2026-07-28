import { useMemo, useState } from "react";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { api, ApiError } from "@/lib/api";
import { toast } from "sonner";
import type { Platform, Account } from "@/lib/types";

const BRAND: Record<string, { bg: string; label: string; icon: string }> = {
  instagram: { bg: "linear-gradient(135deg,#f9737d,#c13584,#833ab4)", label: "Instagram", icon: "📸" },
  facebook: { bg: "#1877f2", label: "Facebook", icon: "👍" },
  youtube: { bg: "#ff0000", label: "YouTube", icon: "▶️" },
};

export function ChannelsPage() {
  const { workspaces, isAdmin, refresh } = useWorkspaces();
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { data: acctData, refetch } = useResource<{ accounts: Account[] }>("/accounts?channel=all");
  const platforms = platData?.platforms ?? [];
  const accounts = acctData?.accounts ?? [];
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // channelId -> platformId -> accountId
  const acctMap = useMemo(() => {
    const m: Record<string, Record<string, string>> = {};
    for (const a of accounts) (m[a.channel_id] ||= {})[a.platform_id] = a.id;
    return m;
  }, [accounts]);

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

  return (
    <section className="screen">
      <div className="hint" style={{ marginBottom: 16 }}>
        🌐 Add brand channels and choose which platforms each one is on. New channels come with Instagram enabled and your content taxonomy copied in, ready to use.
        {!isAdmin && <span style={{ color: "var(--amber)", marginLeft: 6 }}>· Read-only (admins can edit).</span>}
      </div>

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
        {workspaces.map((w) => (
          <div className="chan-card" key={w.id}>
            <div className="chan-top">
              <input
                className="chan-name"
                defaultValue={w.name}
                disabled={!isAdmin}
                onBlur={(e) => rename(w.id, e.target.value, w.name)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <span className="chan-count">
                {platforms.filter((p) => acctMap[w.id]?.[p.id]).length} platform
                {platforms.filter((p) => acctMap[w.id]?.[p.id]).length === 1 ? "" : "s"}
              </span>
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
          </div>
        ))}
      </div>
    </section>
  );
}
