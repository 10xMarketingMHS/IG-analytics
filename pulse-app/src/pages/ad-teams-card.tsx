import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAdTeams, type AdTeam } from "@/lib/ad-teams";
import { SI } from "@/pages/settings-ui";

// Settings › Tasks & time › Ads teams (server/src/routes/ad-teams.js): the
// teams ads are made for — VSL, Longer Life, Webinar — each with its lead. An
// Ad task picks its team and is numbered within it (AID-00001…). The task type
// stays one shared Ads type, so an editor's goal doesn't split by team.

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function AdTeamsCard() {
  const { adTeams, refetch } = useAdTeams();
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/ad-teams", { method: "POST", body: JSON.stringify({ name: name.trim(), leadName: lead.trim() }) });
      await refetch();
      toast.success(`${name.trim()} added · Ad tasks can pick it now.`);
      setName(""); setLead("");
    } catch (e) {
      toast.error(errText(e, "Couldn't add that team."));
    } finally {
      setBusy(false);
    }
  }
  async function save(t: AdTeam, patch: { name?: string; leadName?: string }) {
    try {
      await api(`/ad-teams/${t.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refetch();
      toast.success("Saved.");
    } catch (e) {
      toast.error(errText(e, "Couldn't save that."));
      await refetch();
    }
  }
  async function remove(t: AdTeam) {
    if (!window.confirm(`Remove ${t.name}? Its ${t.tasks} task${t.tasks === 1 ? "" : "s"} keep their team and numbers; it just won't be offered for new Ad tasks.`)) return;
    try {
      await api(`/ad-teams/${t.id}`, { method: "DELETE" });
      await refetch();
      toast.success(`${t.name} removed.`);
    } catch (e) {
      toast.error(errText(e, "Couldn't remove it."));
    }
  }

  return (
    <section className="st-card">
      <div className="st-cardhead">
        <span className="st-titleline"><b>Ads teams</b><span className="st-count">{adTeams?.length ?? 0}</span></span>
        <span>Who the ads are made for. An Ad task picks its team and is numbered within it (AID-00001…). Keep one shared Ads task type above, so each editor has one Ads goal whatever team the ads are for.</span>
      </div>
      {adTeams === null ? <div className="st-empty">Loading…</div> : adTeams.length === 0 ? (
        <div className="st-empty">No teams yet. Add the first below: VSL, Longer Life, Webinar…</div>
      ) : adTeams.map((t) => <TeamRow key={t.id} team={t} onSave={(p) => save(t, p)} onRemove={() => remove(t)} />)}
      <div className="st-foot">
        <input className="st-in grow" placeholder="New team (for example, VSL)" maxLength={40} value={name} disabled={busy}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) add(); }} />
        <input className="st-in" placeholder="Its lead (for example, Muzwer)" maxLength={60} value={lead} disabled={busy} style={{ width: 220 }}
          onChange={(e) => setLead(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) add(); }} />
        <button type="button" className="st-btn pri" disabled={busy || !name.trim()} onClick={add}>{SI.plus}{busy ? "Adding…" : "Add team"}</button>
      </div>
    </section>
  );
}

function TeamRow({ team, onSave, onRemove }: { team: AdTeam; onSave: (p: { name?: string; leadName?: string }) => void; onRemove: () => void }) {
  const [name, setName] = useState(team.name);
  const [lead, setLead] = useState(team.leadName);
  useEffect(() => setName(team.name), [team.name]);
  useEffect(() => setLead(team.leadName), [team.leadName]);
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };
  return (
    <div className="st-row">
      <span className="st-label">
        <input className="st-plain adt-name" value={name} maxLength={40} aria-label="Team name" onChange={(e) => setName(e.target.value)} onKeyDown={blurOnEnter}
          onBlur={() => { const v = name.trim(); if (!v) setName(team.name); else if (v !== team.name) onSave({ name: v }); }} />
        <small>{team.tasks ? `${team.tasks} Ad task${team.tasks === 1 ? "" : "s"}` : "No Ad tasks yet"}</small>
      </span>
      <input className="st-in" value={lead} maxLength={60} placeholder="Lead" aria-label={`${team.name}'s lead`} style={{ width: 220 }}
        onChange={(e) => setLead(e.target.value)} onKeyDown={blurOnEnter}
        onBlur={() => { if (lead.trim() !== team.leadName) onSave({ leadName: lead.trim() }); }} />
      <button type="button" className="st-icobtn" onClick={onRemove} title="Remove" aria-label={`Remove ${team.name}`}>{SI.trash}</button>
    </div>
  );
}
