import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TaskRulesSection } from "@/pages/task-rules";
import { ChannelsSection } from "@/pages/channels";
import { TeamsSection } from "@/pages/teams";
import { GoalSettingSection } from "@/pages/goal-setting";
import { AccessSection } from "@/pages/access";

const REEL_WEIGHTS: [string, number][] = [
  ["Views", 20], ["Like rate", 15], ["Comment rate", 25], ["Share rate", 25], ["Save rate", 15],
];
const CAROUSEL_WEIGHTS: [string, number][] = [
  ["Views", 10], ["Like rate", 10], ["Comment rate", 20], ["Share rate", 30], ["Save rate", 30],
];

// One master Settings page instead of four separate ones — each former page
// (Task Settings, Channels, Teams) is now a tab here, plus this page's own
// original content (taxonomy/scoring) as "Content & Scoring". Tabs an editor
// or viewer can't use at all (Task Settings, Team) are hidden outright rather
// than shown greyed-out — the old pages already 403'd non-admins internally,
// this just avoids surfacing a tab that would immediately say "no access."
// /channels, /task-rules, /teams still route here (old links keep working),
// just pre-selecting the matching tab instead of their own page.
type SettingsTab = "content" | "tasks" | "channels" | "team" | "goals" | "access";
const TAB_FOR_PATH: Record<string, SettingsTab> = {
  "/task-rules": "tasks",
  "/channels": "channels",
  "/teams": "team",
  "/goals": "goals",
};

export function SettingsPage() {
  const { taxonomy, loading, refetch } = useTaxonomy();
  const { isAdmin, hasPermission } = useWorkspaces();
  const location = useLocation();
  const [pillarId, setPillarId] = useState("");
  const [tab, setTab] = useState<SettingsTab>(() => TAB_FOR_PATH[location.pathname] ?? "content");
  // A goal_setting_access grant-holder can VIEW Goal Setting (self-scoped,
  // read-only) — unlock the tab for them, not just the underlying API.
  const canViewGoals = isAdmin || hasPermission("goal_setting_access");

  const TABS = useMemo(
    () =>
      [
        { key: "content" as const, label: "Content & Scoring", show: true },
        { key: "tasks" as const, label: "Task Settings", show: isAdmin },
        { key: "goals" as const, label: "Goal Setting", show: canViewGoals },
        { key: "channels" as const, label: "Channels & Integrations", show: true },
        { key: "team" as const, label: "Team", show: isAdmin },
        { key: "access" as const, label: "Access", show: isAdmin },
      ].filter((t) => t.show),
    [isAdmin, canViewGoals],
  );

  async function add(path: string, body: object, label: string) {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await refetch();
      toast.success(`${label} added.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add.");
    }
  }

  async function remove(path: string, name: string, label: string) {
    if (!window.confirm(`Delete ${label.toLowerCase()} "${name}"?`)) return;
    try {
      await api(path, { method: "DELETE" });
      await refetch();
      toast.success(`${label} deleted.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete.");
    }
  }

  function addPillar() {
    const name = window.prompt("New pillar name")?.trim();
    if (name) add("/pillars", { name }, "Pillar");
  }
  function addAvatar() {
    const name = window.prompt("New avatar name")?.trim();
    if (name) add("/avatars", { name }, "Avatar");
  }
  function addContentType() {
    if (!pillarId) return;
    const name = window.prompt("New content type name")?.trim();
    if (name) add("/content-types", { name, pillarId }, "Content type");
  }
  function addFormat() {
    // Format is channel-wide now — no pillar.
    const name = window.prompt("New format name")?.trim();
    if (!name) return;
    const pt = window.prompt("Post type — type 'reel' or 'carousel'", "reel")?.trim();
    if (pt !== "reel" && pt !== "carousel") {
      toast.error("Post type must be 'reel' or 'carousel'.");
      return;
    }
    add("/formats", { name, postType: pt }, "Format");
  }

  const activePillar = pillarId || taxonomy?.pillars[0]?.id || "";
  const cts = (taxonomy?.contentTypes ?? []).filter((c) => c.pillar_id === activePillar);

  return (
    <section className="screen">
      <div className="seg" style={{ marginBottom: 18 }}>
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "content" && (
        loading || !taxonomy ? (
          <div className="hint">Loading…</div>
        ) : (
          <>
            <div className="sectitle"><span className="dot" />Content taxonomy<span className="s">Pillars &amp; Types nest (P#/T#); Formats are channel-wide (F#)</span></div>
            <div className="card pad">
              <label className="f">Content Pillars</label>
              <div className="taxrow">
                {taxonomy.pillars.map((p) => (
                  <span className="taxchip" key={p.id}>
                    <span className="taxserial">P{p.serial}</span>{p.name}
                    {isAdmin && (
                      <span className="x" title="Delete pillar" onClick={() => remove(`/pillars/${p.id}`, p.name, "Pillar")}>×</span>
                    )}
                  </span>
                ))}
                {isAdmin && <button className="addchip" onClick={addPillar}>＋ Add</button>}
              </div>

              <label className="f" style={{ marginTop: 14 }}>Audience Avatars</label>
              <div className="taxrow">
                {taxonomy.avatars.map((a) => (
                  <span className="taxchip" key={a.id}>
                    {a.name}
                    {isAdmin && (
                      <span className="x" title="Delete avatar" onClick={() => remove(`/avatars/${a.id}`, a.name, "Avatar")}>×</span>
                    )}
                  </span>
                ))}
                {isAdmin && <button className="addchip" onClick={addAvatar}>＋ Add</button>}
              </div>

              <label className="f" style={{ marginTop: 18 }}>Content Types — per pillar</label>
              <select className="t" style={{ maxWidth: 340, marginBottom: 12 }} value={activePillar} onChange={(e) => setPillarId(e.target.value)}>
                {taxonomy.pillars.map((p) => (
                  <option key={p.id} value={p.id}>P{p.serial} — {p.name}</option>
                ))}
              </select>
              <div className="taxrow">
                {cts.map((c) => (
                  <span className="taxchip" key={c.id}>
                    <span className="taxserial">T{c.serial}</span>{c.name}
                    {isAdmin && (
                      <span className="x" title="Delete content type" onClick={() => remove(`/content-types/${c.id}`, c.name, "Content type")}>×</span>
                    )}
                  </span>
                ))}
                {isAdmin && <button className="addchip" onClick={addContentType}>＋ Add</button>}
              </div>

              <label className="f" style={{ marginTop: 18 }}>Formats — channel-wide (fully selectable on every pillar)</label>
              <div className="taxrow">
                {taxonomy.formats.map((f) => (
                  <span className="taxchip" key={f.id}>
                    <span className="taxserial">F{f.serial}</span>{f.name}
                    <span className={"ptbadge " + (f.post_type === "reel" ? "pt-reel" : "pt-car")} style={{ fontSize: 10 }}>{f.post_type}</span>
                    {isAdmin && (
                      <span className="x" title="Delete format" onClick={() => remove(`/formats/${f.id}`, f.name, "Format")}>×</span>
                    )}
                  </span>
                ))}
                {isAdmin && <button className="addchip" onClick={addFormat}>＋ Add</button>}
              </div>

              <div className="hint" style={{ marginTop: 12 }}>
                {isAdmin
                  ? "Pillars (P#) and their Content Types (T#) nest; Formats (F#) are shared across the whole channel. Numbers are permanent — deleting one won't renumber the rest. Deleting an item still used by posts is blocked — reassign those posts first."
                  : "Only admins can add or remove taxonomy items."}
              </div>
            </div>

            <div className="sectitle"><span className="dot" />Scoring weights<span className="s">how the performance score is calculated</span></div>
            <div className="grid g2">
              <div className="card pad">
                <b style={{ fontSize: 13 }}>Reels</b>
                <div style={{ marginTop: 12 }}>
                  {REEL_WEIGHTS.map(([nm, w]) => (
                    <div className="weightrow" key={nm}>
                      <span className="nm">{nm}</span>
                      <span className="bar"><i style={{ width: `${w}%` }} /></span>
                      <span className="wv">{w}%</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card pad">
                <b style={{ fontSize: 13 }}>Carousels</b>
                <div style={{ marginTop: 12 }}>
                  {CAROUSEL_WEIGHTS.map(([nm, w]) => (
                    <div className="weightrow" key={nm}>
                      <span className="nm">{nm}</span>
                      <span className="bar"><i style={{ width: `${w}%` }} /></span>
                      <span className="wv">{w}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )
      )}

      {tab === "tasks" && <TaskRulesSection />}
      {tab === "goals" && <GoalSettingSection />}
      {tab === "channels" && <ChannelsSection />}
      {tab === "team" && <TeamsSection />}
      {tab === "access" && <AccessSection />}
    </section>
  );
}
