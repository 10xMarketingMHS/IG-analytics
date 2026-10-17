import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useEditors } from "@/lib/use-editors";
import { useResource } from "@/lib/use-resource";
import { ACCENTS, useTheme } from "@/components/theme-provider";
import { SCORE_WEIGHTS } from "@/lib/score";
import { DISCIPLINE_CRITERIA } from "@/lib/goal-points";
import { monthName } from "@/lib/goal-periods";
import { TaskRulesSection } from "@/pages/task-rules";
import { ChannelsSection } from "@/pages/channels";
import { EodOversightSection } from "@/pages/eod-oversight";
import { AccessSection } from "@/pages/access";
import { SI, Seg, Stepper, fmtHours } from "@/pages/settings-ui";
import "./settings.css";

// Settings (Pulse Redesign v5): one page, a menu of sections on the left —
// General, Channels, Content, Tasks & time, Scoring, Access and Work day — each
// a stack of flat panels with one setting per row. Sections a person can't use
// at all are left out of the menu. People, logins and roles moved to Team ›
// Roster; each person's goals to Goals › Set goals. /channels and /task-rules
// still land here on their own section; ?s= picks one.
type Section = "general" | "channels" | "content" | "tasks" | "scoring" | "access" | "workday";
const SECTION_FOR_PATH: Record<string, Section> = { "/channels": "channels", "/task-rules": "tasks" };

export function SettingsPage() {
  const { isAdmin, hasPermission } = useWorkspaces();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const canCalendar = hasPermission("edit_goals");

  const SECTIONS: { k: Section; l: string; d: string; icon: ReactNode; show: boolean }[] = [
    { k: "general", l: "General", d: "Work calendar, review cycle, look", icon: SI.tune, show: true },
    { k: "channels", l: "Channels", d: "Brands and platform accounts", icon: SI.hub, show: true },
    { k: "content", l: "Content", d: "Pillars, types, avatars, formats", icon: SI.category, show: true },
    { k: "tasks", l: "Tasks & time", d: "Task types, points, time budgets", icon: SI.timer, show: hasPermission("task_settings") },
    { k: "scoring", l: "Scoring", d: "How scores and rankings work", icon: SI.chart, show: true },
    { k: "access", l: "Access", d: "Extra permissions per person", icon: SI.admin, show: hasPermission("access_manage") },
    { k: "workday", l: "Work day", d: "Who started and ended their day", icon: SI.clock, show: isAdmin },
  ];
  const shown = SECTIONS.filter((s) => s.show);
  const want = (params.get("s") as Section | null) ?? SECTION_FOR_PATH[location.pathname] ?? "general";
  const cur = shown.find((s) => s.k === want) ?? shown[0];
  const go = (k: Section) => navigate(k === "general" ? "/settings" : `/settings?s=${k}`, { replace: true });

  return (
    <section className="screen st">
      <div className="st-head">
        <span className="st-note">
          {SI.shield}
          {isAdmin ? "Super Admin & Admin · changes apply to everyone" : "Some sections can only be changed by an admin"}
        </span>
      </div>
      <div className="st-body">
        <nav className="st-nav" aria-label="Settings sections">
          {shown.map((s) => (
            <button key={s.k} type="button" className={cur.k === s.k ? "on" : ""} aria-current={cur.k === s.k ? "page" : undefined} onClick={() => go(s.k)}>
              {s.icon}
              <span><b>{s.l}</b><small>{s.d}</small></span>
            </button>
          ))}
          {isAdmin && (
            <div className="st-navfoot">
              People and login access live in
              <Link to="/my-team?tab=roster" className="st-link">Team · Roster{SI.arrow}</Link>
            </div>
          )}
        </nav>
        <div className="st-main">
          <div className="st-sechead"><h2>{cur.l}</h2><span>{cur.d}</span></div>
          {cur.k === "general" && <GeneralSection canCalendar={canCalendar} />}
          {cur.k === "channels" && <ChannelsSection />}
          {cur.k === "content" && <ContentSection />}
          {cur.k === "tasks" && <TaskRulesSection />}
          {cur.k === "scoring" && <ScoringSection />}
          {cur.k === "access" && <AccessSection />}
          {cur.k === "workday" && <EodOversightSection />}
        </div>
      </div>
    </section>
  );
}

// ── General ──────────────────────────────────────────────────────────────────
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function GeneralSection({ canCalendar }: { canCalendar: boolean }) {
  return (
    <>
      {canCalendar && <WorkCalendar />}
      <section className="st-card">
        <div className="st-cardhead">
          <b>Review cycle</b>
          <span>Goals are checked twice a month. Goals shows each review on its own, or the whole month.</span>
        </div>
        <div className="st-cycle">
          <div><span>Review 1</span><b>1st – 15th</b></div>
          <div><span>Review 2</span><b>16th – month end</b></div>
          <div><span>Full month</span><b>Both combined</b></div>
        </div>
      </section>
      <Appearance />
    </>
  );
}

type CapResp = {
  capacity: { workingDays: number; hoursPerDay: number; source: string };
  orgDefault: { workingDays: number; hoursPerDay: number } | null;
};

// The team's working days and hours a day for a month — every editor's
// capacity unless they have their own (set on Goals › Set goals). Read from any
// editor without their own hours; nothing saved means the server's 22 × 8.
function WorkCalendar() {
  const { editors } = useEditors();
  const months = useMemo(() => {
    const d = new Date();
    return [ymOf(new Date(d.getFullYear(), d.getMonth(), 1)), ymOf(new Date(d.getFullYear(), d.getMonth() + 1, 1))];
  }, []);
  const [month, setMonth] = useState(months[0]);
  const [base, setBase] = useState<{ days: number; hours: number; source: string } | null>(null);
  const [days, setDays] = useState(22);
  const [hours, setHours] = useState(8);
  const [saving, setSaving] = useState(false);
  const [rev, setRev] = useState(0);
  const ids = (editors ?? []).filter((e) => e.active).map((e) => e.id).join(",");

  useEffect(() => {
    if (!ids) return;
    let live = true;
    setBase(null);
    (async () => {
      let found: { days: number; hours: number; source: string } | null = null;
      for (const id of ids.split(",")) {
        try {
          const d = await api<CapResp>(`/goals?editorId=${id}&month=${month}-01`);
          if (d.orgDefault) found = { days: d.orgDefault.workingDays, hours: d.orgDefault.hoursPerDay, source: "org" };
          else if (d.capacity.source !== "editor") found = { days: d.capacity.workingDays, hours: d.capacity.hoursPerDay, source: d.capacity.source };
          if (found) break;
        } catch { /* try the next person */ }
      }
      found ??= { days: 22, hours: 8, source: "default" };
      if (live) { setBase(found); setDays(found.days); setHours(found.hours); }
    })();
    return () => { live = false; };
  }, [ids, month, rev]);

  const [y, m] = month.split("-").map(Number);
  const dim = new Date(y, m, 0).getDate();
  let sundays = 0;
  for (let d = 1; d <= dim; d++) if (new Date(y, m - 1, d).getDay() === 0) sundays++;
  const cap = days * hours;
  const mon = monthName(month).split(" ")[0];
  const changed = !!base && (days !== base.days || hours !== base.hours);
  const canSave = !!base && (changed || base.source !== "org");

  async function save() {
    setSaving(true);
    try {
      await api("/goals/capacity", { method: "PUT", body: JSON.stringify({ scope: "org", month: `${month}-01`, workingDays: days, hoursPerDay: hours }) });
      toast.success(`Work calendar saved for ${monthName(month)}.`);
      setRev((r) => r + 1);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the work calendar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="st-card">
      <div className="st-cardhead">
        <b>Work calendar</b>
        <span>Sets each editor's monthly capacity. Goals set on Goals · Set goals must fit inside it.</span>
      </div>
      <div className="st-row">
        <span className="st-label"><b>Month</b></span>
        <Seg label="Month" value={month} options={months.map((k) => [k, monthName(k)] as [string, string])} onChange={setMonth} />
      </div>
      {!base ? (
        <div className="st-empty">Loading…</div>
      ) : (
        <>
          <div className="st-row">
            <span className="st-label">
              <b>Working days</b>
              <small>{dim} days in {mon} − {sundays} Sundays = {dim - sundays} days that aren't Sunday</small>
            </span>
            <Stepper label="working days" value={`${days} days`} onDec={() => setDays((d) => Math.max(0, d - 1))} onInc={() => setDays((d) => Math.min(dim, d + 1))}
              decDisabled={days <= 0} incDisabled={days >= dim} />
          </div>
          <div className="st-row">
            <span className="st-label">
              <b>Hours a day</b>
              <small>Working hours after lunch and tea</small>
            </span>
            <Stepper label="hours a day" value={fmtHours(hours)} onDec={() => setHours((h) => Math.max(0.5, h - 0.25))} onInc={() => setHours((h) => Math.min(16, h + 0.25))}
              decDisabled={hours <= 0.5} incDisabled={hours >= 16} />
          </div>
          <div className="st-row sunk">
            <span className="st-calc">
              <span>{monthName(month)} · per editor</span>
              <span>{days} working days × {fmtHours(hours)} = {fmtHours(cap)}</span>
              <span>{base.source === "org" ? (changed ? "Not saved yet" : `Saved for ${mon}`)
                : base.source === "carry" ? `Not saved for ${mon} yet — carried over from an earlier month`
                : "Not saved yet — the standard 22 days × 8h"}</span>
            </span>
            <span className="st-big"><b>{fmtHours(cap)}</b><span>capacity / editor</span></span>
          </div>
          <div className="st-foot">
            <span className="st-note">People with their own hours keep them. Change those on Goals · Set goals.</span>
            <button type="button" className="st-btn pri" disabled={!canSave || saving} onClick={save}>
              {saving ? "Saving…" : `Save for ${mon}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Appearance() {
  const { theme, toggle, accent, setAccent } = useTheme();
  return (
    <section className="st-card">
      <div className="st-cardhead">
        <b>Appearance</b>
        <span>Only changes how Pulse looks for you, on this browser</span>
      </div>
      <div className="st-row">
        <span className="st-label"><b>Theme</b></span>
        <Seg label="Theme" value={theme} options={[["light", "Light"], ["dark", "Dark"]]} onChange={(t) => { if (t !== theme) toggle(); }} />
      </div>
      <div className="st-row">
        <span className="st-label"><b>Accent</b><small>Tints the background and every highlight</small></span>
        <div className="st-accents" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button key={a.key} type="button" role="radio" aria-checked={accent === a.key} aria-label={a.label} title={a.label}
              className={accent === a.key ? "on" : ""} style={{ background: a.swatch }} onClick={() => setAccent(a.key)} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Content ──────────────────────────────────────────────────────────────────
type TxTab = "pillars" | "avatars" | "formats";
type PostRef = { pillar_id?: string; avatar_id?: string; format_id?: string; content_type_id?: string; is_collab_mirror?: boolean };

function ContentSection() {
  const { taxonomy, refetch } = useTaxonomy();
  const { hasPermission } = useWorkspaces();
  const canEdit = hasPermission("content_taxonomy");
  const { data: postData } = useResource<{ posts: PostRef[] }>("/posts?channel=all");
  const [tab, setTab] = useState<TxTab>("pillars");
  const [newName, setNewName] = useState("");
  const [newPT, setNewPT] = useState<"reel" | "carousel">("reel");
  const [typeFor, setTypeFor] = useState<string | null>(null);
  const [typeName, setTypeName] = useState("");

  // How many posts use each pillar, avatar, format and content type — an item
  // in use can't be deleted (the server refuses it too).
  const used = useMemo(() => {
    const m = new Map<string, number>();
    const bump = (id?: string) => { if (id) m.set(id, (m.get(id) ?? 0) + 1); };
    for (const p of postData?.posts ?? []) {
      if (p.is_collab_mirror) continue;
      bump(p.pillar_id); bump(p.avatar_id); bump(p.format_id); bump(p.content_type_id);
    }
    return m;
  }, [postData]);
  const countOf = (id: string) => (postData ? used.get(id) ?? 0 : null);

  async function add(path: string, body: object, label: string) {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await refetch();
      toast.success(`${label} added.`);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add.");
      return false;
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
  async function addNew() {
    const name = newName.trim();
    if (!name) return;
    const ok = tab === "pillars" ? await add("/pillars", { name }, "Pillar")
      : tab === "avatars" ? await add("/avatars", { name }, "Avatar")
      : await add("/formats", { name, postType: newPT }, "Format");
    if (ok) setNewName("");
  }
  async function addType(pillarId: string) {
    const name = typeName.trim();
    if (!name) { setTypeFor(null); return; }
    if (await add("/content-types", { name, pillarId }, "Content type")) { setTypeName(""); setTypeFor(null); }
  }

  const HINT: Record<TxTab, string> = {
    pillars: "Top-level themes. Each holds its own content types.",
    avatars: "Who a post speaks to — powers Views by avatar.",
    formats: "Shared across every pillar and channel.",
  };
  const PH: Record<TxTab, string> = { pillars: "New pillar name", avatars: "New avatar name", formats: "New format name" };
  const dot = (i: number, shift: number) => `oklch(0.66 0.13 ${(i * 67 + shift) % 360})`;
  const usedText = (n: number | null) => (n == null ? "" : n ? `${n} post${n === 1 ? "" : "s"}` : "Not used yet");
  const delBtn = (n: number | null, onDel: () => void, what: string) => !canEdit ? null : n ? (
    <button type="button" className="st-icobtn locked" title={`In use by ${n} post${n === 1 ? "" : "s"}`} aria-label={`${what} is in use`} disabled>{SI.lock}</button>
  ) : (
    <button type="button" className="st-icobtn" title="Delete" aria-label={`Delete ${what}`} onClick={onDel}>{SI.trash}</button>
  );

  return (
    <>
      <section className="st-card">
        <div className="st-row" style={{ borderTop: 0 }}>
          <Seg label="What to edit" value={tab} options={[["pillars", "Pillars"], ["avatars", "Audience avatars"], ["formats", "Formats"]]}
            onChange={(t) => { setTab(t); setNewName(""); }} />
          <span className="st-note" style={{ flex: "1 1 160px" }}>{HINT[tab]}</span>
        </div>
        {!taxonomy ? (
          <div className="st-empty">Loading…</div>
        ) : tab === "pillars" ? (
          taxonomy.pillars.length === 0 ? <div className="st-empty">No pillars yet.</div> : taxonomy.pillars.map((p, i) => {
            const types = taxonomy.contentTypes.filter((c) => c.pillar_id === p.id);
            const n = countOf(p.id);
            return (
              <div className="st-row" key={p.id}>
                <span className="st-tx">
                  <i style={{ background: dot(i, 30) }} />
                  <span>
                    <b><span className="st-chip ser">P{p.serial}</span>{p.name}</b>
                    {(types.length > 0 || canEdit) && (
                      <span className="st-types">
                        {types.map((c) => {
                          const tn = countOf(c.id);
                          return (
                            <span className="st-chip" key={c.id} title={tn ? `${tn} post${tn === 1 ? "" : "s"}` : undefined}>
                              <span className="st-chip ser">T{c.serial}</span>{c.name}
                              {canEdit && !tn && (
                                <button type="button" aria-label={`Delete content type ${c.name}`} title="Delete" onClick={() => remove(`/content-types/${c.id}`, c.name, "Content type")}>×</button>
                              )}
                            </span>
                          );
                        })}
                        {canEdit && (typeFor === p.id ? (
                          <input className="st-chipin" autoFocus placeholder="New content type" value={typeName}
                            onChange={(e) => setTypeName(e.target.value)} onBlur={() => addType(p.id)}
                            onKeyDown={(e) => { if (e.key === "Enter") addType(p.id); if (e.key === "Escape") { setTypeName(""); setTypeFor(null); } }} />
                        ) : (
                          <button type="button" className="st-chipadd" onClick={() => { setTypeFor(p.id); setTypeName(""); }}>{SI.plus}Type</button>
                        ))}
                      </span>
                    )}
                  </span>
                </span>
                <span className="st-used">{usedText(n)}</span>
                {delBtn(n, () => remove(`/pillars/${p.id}`, p.name, "Pillar"), p.name)}
              </div>
            );
          })
        ) : tab === "avatars" ? (
          taxonomy.avatars.length === 0 ? <div className="st-empty">No avatars yet.</div> : taxonomy.avatars.map((a, i) => {
            const n = countOf(a.id);
            return (
              <div className="st-row" key={a.id}>
                <span className="st-tx"><i style={{ background: dot(i, 200) }} /><span><b>{a.name}</b></span></span>
                <span className="st-used">{usedText(n)}</span>
                {delBtn(n, () => remove(`/avatars/${a.id}`, a.name, "Avatar"), a.name)}
              </div>
            );
          })
        ) : (
          taxonomy.formats.length === 0 ? <div className="st-empty">No formats yet.</div> : taxonomy.formats.map((f, i) => {
            const n = countOf(f.id);
            return (
              <div className="st-row" key={f.id}>
                <span className="st-tx">
                  <i style={{ background: dot(i, 120) }} />
                  <span><b><span className="st-chip ser">F{f.serial}</span>{f.name} <span className={"st-pt " + (f.post_type === "reel" ? "reel" : "carousel")}>{f.post_type}</span></b></span>
                </span>
                <span className="st-used">{usedText(n)}</span>
                {delBtn(n, () => remove(`/formats/${f.id}`, f.name, "Format"), f.name)}
              </div>
            );
          })
        )}
        {canEdit && taxonomy && (
          <div className="st-foot">
            <input className="st-in grow" placeholder={PH[tab]} value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addNew(); }} />
            {tab === "formats" && (
              <select className="st-in" value={newPT} onChange={(e) => setNewPT(e.target.value as "reel" | "carousel")} aria-label="Post type" style={{ width: 120 }}>
                <option value="reel">Reel</option>
                <option value="carousel">Carousel</option>
              </select>
            )}
            <button type="button" className="st-btn pri" disabled={!newName.trim()} onClick={addNew}>{SI.plus}Add</button>
          </div>
        )}
      </section>
      <span className="st-note">
        {SI.lockSm}
        {canEdit
          ? "Items in use can't be deleted — reassign their posts first. P#, T# and F# numbers never change, even after a delete."
          : "Only admins can add or remove these."}
      </span>
    </>
  );
}

// ── Scoring ──────────────────────────────────────────────────────────────────
type Thresholds = { epiMinPct: number; mpiMinPct: number; isDefault?: boolean };

function ScoringSection() {
  const { isAdmin, hasPermission } = useWorkspaces();
  const W: [string, number][] = [
    ["View", SCORE_WEIGHTS.view], ["Like", SCORE_WEIGHTS.like], ["Comment", SCORE_WEIGHTS.comment],
    ["Share", SCORE_WEIGHTS.share], ["Save", SCORE_WEIGHTS.save],
  ];
  const total = W.reduce((s, [, w]) => s + w, 0);
  return (
    <>
      <section className="st-card">
        <div className="st-cardhead">
          <b>Performance score · content</b>
          <span>Each count becomes a rate of reach, then gets a weight. Every post's score in Analytics and the Leaderboard comes from this.</span>
        </div>
        {W.map(([l, w]) => (
          <div className="st-row" key={l}>
            <span className="st-wl">{l} rate</span>
            <span className="st-weight" aria-hidden="true"><i style={{ width: `${w * 2}%` }} /></span>
            <b className="st-wv">× {w}</b>
          </div>
        ))}
        <div className="st-foot">
          <span className="st-note st-mono">{W.map(([l, w]) => `${l} × ${w}`).join("  +  ")}</span>
          <span className={"st-chip " + (total === 100 ? "good" : "bad")}>{total === 100 ? SI.checkCircle : SI.error}Weights total {total}</span>
        </div>
      </section>

      <section className="st-card">
        <div className="st-cardhead">
          <b>Work score · task points</b>
          <span>Ranks the team on My Team and the Leaderboard. A finished task earns its type's points, less if it was late.</span>
        </div>
        {([
          ["On or before the due date", "Full points"],
          ["1 day late", "Half the points"],
          ["2 days late", "No points"],
          ["3 or more days late", "Points taken back"],
          ["Waiting for a reviewer", "Doesn't count as late"],
        ] as const).map(([l, v]) => (
          <div className="st-row" key={l}><span className="st-label"><b>{l}</b></span><span className="st-value">{v}</span></div>
        ))}
        {hasPermission("task_settings") && (
          <div className="st-foot">
            <span className="st-note">Each task type's points are set in Tasks & time.</span>
            <Link to="/settings?s=tasks" className="st-link">Tasks & time{SI.arrow}</Link>
          </div>
        )}
      </section>

      {isAdmin && <PerformanceBands />}

      <section className="st-card">
        <div className="st-cardhead">
          <b>Discipline ratings</b>
          <span>Rated 0–5 per person each month on Goals · Discipline. Together they make up 20% of the goal score.</span>
        </div>
        <div className="st-crit">
          {DISCIPLINE_CRITERIA.map((c, i) => <span key={c.key}><i>{i + 1}</i>{c.label}</span>)}
        </div>
      </section>
    </>
  );
}

// Management Performance: the two cut-offs that band each person's Overall
// Performance % into EPI / MPI / LPI (Leaderboard › Management Performance).
function PerformanceBands() {
  const [thr, setThr] = useState<Thresholds | null>(null);
  const [epi, setEpi] = useState("85");
  const [mpi, setMpi] = useState("75");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Thresholds>("/management-performance/thresholds")
      .then((d) => { setThr(d); setEpi(String(d.epiMinPct)); setMpi(String(d.mpiMinPct)); })
      .catch(() => setThr({ epiMinPct: 85, mpiMinPct: 75, isDefault: true }));
  }, []);

  const epiN = Number(epi), mpiN = Number(mpi);
  const valid = epiN > 0 && mpiN > 0 && epiN <= 100 && mpiN <= 100 && mpiN <= epiN;
  const changed = !!thr && (epiN !== thr.epiMinPct || mpiN !== thr.mpiMinPct);

  async function save() {
    if (!valid) { toast.error("The MPI minimum can't be higher than the EPI minimum."); return; }
    setSaving(true);
    try {
      const saved = await api<Thresholds>("/management-performance/thresholds", { method: "PUT", body: JSON.stringify({ epiMinPct: epiN, mpiMinPct: mpiN }) });
      setThr(saved);
      toast.success("Bands saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="st-card">
      <div className="st-cardhead">
        <b>Management performance bands</b>
        <span>Overall Performance % = goal points earned (80%) + discipline (20%), out of the goal points set. Shown on Leaderboard · Management Performance.</span>
      </div>
      {!thr ? <div className="st-empty">Loading…</div> : (
        <>
          <div className="st-row">
            <span className="st-label"><b><span className="st-band epi">EPI</span></b><small>{epiN}% and above</small></span>
            <span className="st-pct"><input className="st-in" type="number" min={1} max={100} step={1} value={epi} onChange={(e) => setEpi(e.target.value)} aria-label="EPI minimum percent" />%</span>
          </div>
          <div className="st-row">
            <span className="st-label"><b><span className="st-band mpi">MPI</span></b><small>{mpiN}% up to {epiN}%</small></span>
            <span className="st-pct"><input className="st-in" type="number" min={1} max={100} step={1} value={mpi} onChange={(e) => setMpi(e.target.value)} aria-label="MPI minimum percent" />%</span>
          </div>
          <div className="st-row">
            <span className="st-label"><b><span className="st-band lpi">LPI</span></b><small>Below {mpiN}%</small></span>
          </div>
          <div className="st-foot">
            <span className="st-note" style={valid ? undefined : { color: "var(--st-bad)" }}>
              {!valid ? "The MPI minimum can't be higher than the EPI minimum." : thr.isDefault ? "These are the defaults — not saved yet." : "Saved."}
            </span>
            <button type="button" className="st-btn pri" disabled={!valid || saving || (!changed && !thr.isDefault)} onClick={save}>{saving ? "Saving…" : "Save bands"}</button>
          </div>
        </>
      )}
    </section>
  );
}
