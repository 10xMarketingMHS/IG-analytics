import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { AdTeam } from "@/lib/ad-teams";
import type { ContentFormatDef, Editor, Task } from "@/lib/types";
import { isHeading } from "@/lib/type-groups";
import "./schedule-block.css";
import "./rnd-use-block.css";

// The "What it becomes" part of approved R&D work's window: a Service task whose
// type's Next step is ticked (Settings › Tasks & time — AI Job, whose video goes
// for approval before anyone knows what it'll be). A Manager, Asst. Manager or
// Team Lead decides: a Reel, an Ad, both, or not used. A Reel or an Ad is made
// here as a new task (POST /tasks, like any other, with the approved video
// attached), then the decision is recorded with them (POST /tasks/:id/use,
// server/src/routes/tasks.js). The R&D task keeps its points whatever is decided.

type Kind = "social" | "ad";
type Decision = "reel" | "ad" | "both" | "none";
type Draft = { contentFormatId: string; channelId: string; adTeamId: string; editorId: string; dueDate: string };
const KINDS_OF: Record<Exclude<Decision, "none">, Kind[]> = { reel: ["social"], ad: ["ad"], both: ["social", "ad"] };
const KIND_WORD: Record<Kind, string> = { social: "Reel", ad: "Ad" };
const DECIDED: Record<Decision, string> = { reel: "Became a Reel", ad: "Became an Ad", both: "Became a Reel and an Ad", none: "Not used" };
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function RndUseBlock({ task, formats, people, channels, adTeams, canDecide, onChanged }: {
  task: Task;
  formats: ContentFormatDef[];
  people: Editor[];
  channels: { id: string; name: string }[];
  adTeams: AdTeam[];
  canDecide: boolean;
  onChanged: () => void;
}) {
  const use = task.meta?.use;
  const [pick, setPick] = useState<Decision | null>(null);
  const [drafts, setDrafts] = useState<Record<Kind, Draft> | null>(null);
  // made already on an earlier try (the decision didn't save): not made twice
  const [made, setMade] = useState<Partial<Record<Kind, { id: string; ref: string }>>>({});
  const [busy, setBusy] = useState(false);
  const typeName = formats.find((f) => f.id === task.content_format_id)?.name ?? "R&D work";
  const ref = task.svid ?? task.tid ?? "";
  const byTeam = adTeams.length > 0;
  // a main type with sub-types is only a heading: the choice is one of its sub-types
  const typesOf = (k: Kind) => formats.filter((f) => f.active && f.category === k && !isHeading(f.id, formats));
  const blank = (k: Kind): Draft => {
    const list = formats.filter((f) => f.active && f.category === k);
    const first = (k === "social" ? list.find((f) => /reel/i.test(f.name)) : undefined) ?? list[0];
    // starts on no type if that's a heading, rather than guess which sub-type
    return { contentFormatId: first && !isHeading(first.id, formats) ? first.id : "", channelId: task.channel_id ?? "", adTeamId: "", editorId: task.editor_id ?? "", dueDate: "" };
  };
  const choose = (d: Decision) => {
    setPick(d);
    if (d !== "none" && !drafts) setDrafts({ social: blank("social"), ad: blank("ad") });
  };
  const setD = (k: Kind, patch: Partial<Draft>) => setDrafts((all) => (all ? { ...all, [k]: { ...all[k], ...patch } } : all));

  if (use) {
    return (
      <section className="sch rnd" aria-label="What it became">
        <div className="sch-head">
          <b>What it became</b>
          <span className={"sch-pill " + (use.decision === "none" ? "" : "live")}>{DECIDED[use.decision]}</span>
        </div>
        <p className="sch-say">
          {use.decision === "none"
            ? "Not used: it stays as R&D work, and its points are counted."
            : <>Made into {use.tasks.map((t, i) => <span key={t.id}>{i ? " and " : ""}<b>{t.ref ?? KIND_WORD[t.kind as Kind]}</b> ({t.kind === "ad" ? "Ad" : "Reel"})</span>)}. Its own points are counted; each of them earns its own.</>}
          <span className="rnd-by"> {use.byName ? `Decided by ${use.byName}` : "Decided"}, {day(use.at)}.</span>
        </p>
      </section>
    );
  }

  if (!canDecide) {
    return (
      <section className="sch rnd" aria-label="What it becomes">
        <div className="sch-head"><b>What it becomes</b><span className="sch-pill to_schedule">To decide</span></div>
        <p className="sch-say">Approved, and its points are counted. A Manager or Team Lead decides what it becomes: a Reel, an Ad or both.</p>
      </section>
    );
  }

  const kinds = pick && pick !== "none" ? KINDS_OF[pick] : [];
  const missing = (k: Kind) => {
    const d = drafts?.[k];
    if (!d) return "…";
    if (!d.contentFormatId) return `Pick the ${KIND_WORD[k]}'s type.`;
    if (k === "ad" && byTeam ? !d.adTeamId : !d.channelId) return k === "ad" && byTeam ? "Pick the Ads team." : `Pick the ${KIND_WORD[k]}'s brand.`;
    if (!d.editorId) return `Pick who makes the ${KIND_WORD[k]}.`;
    return null;
  };
  const why = kinds.map((k) => (made[k] ? null : missing(k))).find(Boolean) ?? null;

  async function make() {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const done = { ...made };
      for (const k of kinds) {
        if (done[k]) continue;
        const d = drafts![k];
        const attachments = [
          ...(task.delivery_link ? [{ url: task.delivery_link, label: `${typeName} video (${ref})` }] : []),
          ...(task.attachments ?? []),
        ].slice(0, 20);
        const r = await api<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify({
          title: task.title,
          description: `Made from ${ref} (${typeName}).${task.description ? `\n\n${task.description}` : ""}`,
          taskType: k, status: "todo",
          channelId: k === "ad" && byTeam ? null : d.channelId || null,
          ...(k === "ad" && byTeam ? { adTeamId: d.adTeamId } : {}),
          editorId: d.editorId || null, dueDate: d.dueDate || null, priority: task.priority,
          contentFormatId: d.contentFormatId, attachments,
        }) });
        done[k] = { id: r.task.id, ref: r.task.sid ?? r.task.ad_id ?? r.task.tid ?? KIND_WORD[k] };
        setMade({ ...done });
      }
      await api(`/tasks/${task.id}/use`, { method: "POST", body: JSON.stringify({
        decision: pick, taskIds: pick === "none" ? [] : kinds.map((k) => done[k]!.id),
      }) });
      toast.success(pick === "none" ? `${ref || "It"} marked not used.` : `Made ${kinds.map((k) => done[k]!.ref).join(" and ")} from ${ref || "it"}.`);
      onChanged();
    } catch (e) {
      toast.error(errText(e, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sch rnd" aria-label="What it becomes">
      <div className="sch-head"><b>What does it become?</b><span className="sch-pill to_schedule">To decide</span></div>
      <p className="sch-say">Approved, and its points are counted. Make it a Reel, an Ad or both: each becomes a new task with this video attached. Or mark it not used.</p>
      <div className="rnd-picks" role="group" aria-label="What it becomes">
        {([["reel", "🎬 Reel"], ["ad", "📢 Ad"], ["both", "🎬 + 📢 Both"], ["none", "Not used"]] as const).map(([d, label]) => (
          <button key={d} type="button" className={"rnd-pick" + (pick === d ? " on" : "") + (d === "none" ? " quiet" : "")} aria-pressed={pick === d}
            disabled={busy || (Object.keys(made).length > 0 && d !== pick)} onClick={() => choose(d)}>{label}</button>
        ))}
      </div>
      {drafts && kinds.map((k) => {
        const d = drafts[k];
        if (made[k]) return <div key={k} className="sch-details"><span className="sch-details-h">{KIND_WORD[k]}: <b>{made[k]!.ref}</b> made</span></div>;
        return (
          <div key={k} className="sch-details">
            <span className="sch-details-h">{k === "social" ? "🎬 The Reel" : "📢 The Ad"}<small>a new {k === "social" ? "Social" : "Ads"} task</small></span>
            <div className="sch-grid">
              <label>Type
                <select value={d.contentFormatId} onChange={(e) => setD(k, { contentFormatId: e.target.value })}>
                  <option value="">Pick a type</option>
                  {typesOf(k).map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
                </select>
              </label>
              {k === "ad" && byTeam ? (
                <label>Ads team
                  <select value={d.adTeamId} onChange={(e) => setD(k, { adTeamId: e.target.value })}>
                    <option value="">Pick a team</option>
                    {adTeams.map((x) => <option key={x.id} value={x.id}>{x.name}{x.leadName ? ` · ${x.leadName}` : ""}</option>)}
                  </select>
                </label>
              ) : (
                <label>Brand
                  <select value={d.channelId} onChange={(e) => setD(k, { channelId: e.target.value })}>
                    <option value="">Pick a brand</option>
                    {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              )}
              <label>Who makes it
                <select value={d.editorId} onChange={(e) => setD(k, { editorId: e.target.value })}>
                  <option value="">Pick someone</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label>Due <small>(optional)</small>
                <input type="date" value={d.dueDate} onChange={(e) => setD(k, { dueDate: e.target.value })} />
              </label>
            </div>
          </div>
        );
      })}
      {pick === "none" && <p className="sch-say rnd-none">It stays as R&D work and keeps its points. Nothing new is made.</p>}
      {pick && (
        <div className="rnd-go">
          {why && <span className="rnd-why">{why}</span>}
          <button type="button" className="btn btn-sm" disabled={busy || Object.keys(made).length > 0} onClick={() => setPick(null)}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!why} onClick={make}>
            {busy ? "Saving…" : pick === "none" ? "Mark not used" : pick === "both" ? "Make both" : `Make the ${pick === "reel" ? "Reel" : "Ad"}`}
          </button>
        </div>
      )}
    </section>
  );
}
