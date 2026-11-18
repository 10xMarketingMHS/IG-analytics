import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, API_BASE, ApiError } from "@/lib/api";
import { relTime } from "@/lib/activity-meta";
import { LookOnly, SI } from "@/pages/settings-ui";

// Settings › Connected apps (server/src/routes/connections.js): Animus — the
// VSL team's ads register — connects to one Ads team with one line made here.
// The line is shown once: paste it into Animus (the funnel's settings, Echo
// connection) and it picks approved Ad work and sends back the AD numbers.
// Revoking a connection ends it at once. For the Managers and the Super Admin.

type Connection = {
  id: string; app: string; label: string; teamId: string; teamName: string;
  createdAt: string; createdByName: string | null; lastUsedAt: string | null; revokedAt: string | null;
};
type Data = { connections: Connection[]; teams: { id: string; name: string; leadName: string }[] };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
// the line: where Echo's API is, then the token after "#" (an app sends it in a header, never in the address)
const lineOf = (token: string) => `${new URL(API_BASE, window.location.origin).href.replace(/\/$/, "")}/animus#${token}`;

export function ConnectedAppsSection({ canChange = true }: { canChange?: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ line: string; teamName: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const d = await api<Data>("/connections");
      setData(d);
      setError(null);
      setTeamId((b) => b || (d.teams.length === 1 ? d.teams[0].id : ""));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load the connected apps.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy(true);
    try {
      const r = await api<{ connection: Connection; token: string }>("/connections", { method: "POST", body: JSON.stringify({ teamId, label: label.trim() || undefined }) });
      setMade({ line: lineOf(r.token), teamName: r.connection.teamName });
      setLabel("");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't make the connection.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(c: Connection) {
    if (!window.confirm(`Revoke ${c.label || "this connection"} (${c.teamName})? Animus stops reaching Echo through it at once. You can make a new line any time.`)) return;
    try {
      await api(`/connections/${c.id}`, { method: "DELETE" });
      toast.success("Revoked. That line no longer works.");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't revoke it.");
    }
  }
  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.line);
      toast.success("Copied. Paste it into Animus.");
    } catch {
      toast.error("Couldn't copy: select the line and copy it.");
    }
  }

  if (error) return <section className="st-card"><div className="st-empty">{error}</div></section>;
  if (!data) return <section className="st-card"><div className="st-empty">Loading…</div></section>;
  const live = data.connections.filter((c) => !c.revokedAt), gone = data.connections.filter((c) => c.revokedAt);
  return (
    <LookOnly on={!canChange}>
      <section className="st-card">
        <div className="st-cardhead">
          <span className="st-titleline"><b>Connected apps</b><span className="st-count">{live.length}</span></span>
          <span>Animus connects to one Ads team with one line made here. It picks that team's approved ads in its Builder and sends back the AD numbers each one became, straight into Ad uploads.</span>
        </div>
        {live.length === 0 && <div className="st-empty">Nothing connected yet. Make a line below.</div>}
        {live.map((c) => (
          <div key={c.id} className="st-row">
            <span className="st-label">
              <b>Animus{c.label ? ` · ${c.label}` : ""}</b>
              <small>{c.teamName} · made {day(c.createdAt)}{c.createdByName ? ` by ${c.createdByName}` : ""} · {c.lastUsedAt ? `last used ${relTime(c.lastUsedAt)}` : "not used yet"}</small>
            </span>
            <button type="button" className="st-btn sm danger" onClick={() => revoke(c)}>{SI.unlink}Revoke</button>
          </div>
        ))}
        {made && (
          <div className="st-row cx-made">
            <span className="st-label">
              <b>{SI.check} The line for {made.teamName}: shown only this once</b>
              <small>Paste it into Animus › the funnel's settings › Echo connection. Lost it? Revoke it and make a new one.</small>
            </span>
            <div className="cx-line">
              <input className="st-in grow" readOnly value={made.line} aria-label="Connection line" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="st-btn pri" onClick={copy}>Copy</button>
              <button type="button" className="st-btn" onClick={() => setMade(null)}>Done</button>
            </div>
          </div>
        )}
        <div className="st-foot">
          <select className="st-in" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Ads team it connects to" style={{ width: 180 }}>
            <option value="">{data.teams.length ? "Ads team…" : "No Ads teams yet"}</option>
            {data.teams.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className="st-in grow" placeholder="Name it (for example, VSL funnel)" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button type="button" className="st-btn pri" disabled={busy || !teamId} onClick={connect}>{SI.link}{busy ? "Making…" : "Connect Animus"}</button>
        </div>
      </section>
      {gone.length > 0 && (
        <span className="st-note">
          Revoked: {gone.map((c) => `${c.label || "Animus"} (${c.teamName}, ${day(c.revokedAt!)})`).join(", ")}.
        </span>
      )}
    </LookOnly>
  );
}
