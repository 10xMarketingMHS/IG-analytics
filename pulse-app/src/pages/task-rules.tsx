import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useContentFormats } from "@/lib/use-content-formats";
import { useIsSuper, useOrg } from "@/lib/use-org";
import { useEditors } from "@/lib/use-editors";
import { positionKey } from "@/lib/home-role";
import type { ContentFormatDef, TaskTimeRule } from "@/lib/types";
import { LookOnly, SI, Stepper, Toggle, fmtHours } from "@/pages/settings-ui";
import { AdTeamsCard } from "@/pages/ad-teams-card";
import { groupTypes, kindsWord, useFolds } from "@/lib/type-groups";
import { scheduleTypeIds } from "@/lib/schedule-types";

// Settings › Tasks & time (Pulse Redesign v5): every task type in one list,
// grouped Social / Ads / Service / Project — its icon, name, category, whether
// it needs a delivery link for review, whether approved Social work of it goes
// to Scheduling, its Key/Critical metric tag, points and
// time budget (a project type has a duration in days instead). Each change
// saves on its own a moment after the last click. Below: breaks and the task
// rules everyone works by. Admins or the task_settings grant.

// A curated set — enough variety for common content work without turning the
// picker into an unscrollable wall of emoji.
// A row each: content, devices and tools, video and audio, ads and marketing,
// writing and the web, AI / R&D and operations.
const ICON_OPTIONS = [
  "🎬", "🖼️", "📷", "🎥", "▶️", "🎙️", "📝", "🎨",
  "📱", "🖥️", "📊", "🗓️", "💡", "✂️", "🔊", "🔧",
  "🎞️", "📹", "📸", "🎤", "🎧", "🎵", "🎭", "🖌️",
  "📣", "📢", "🎯", "📈", "💰", "🛒", "🏷️", "🎁",
  "✍️", "📄", "📋", "📧", "💬", "🌐", "💻", "🔗",
  "🤖", "🧪", "🧠", "📦", "🗂️", "🔍", "⚙️", "✅",
];

type Cat = "social" | "ad" | "service" | "project";
const CATS: { key: Cat; label: string; icon: ReactNode }[] = [
  { key: "social", label: "Social", icon: SI.megaphone },
  { key: "ad", label: "Ads", icon: SI.card },
  { key: "service", label: "Service", icon: SI.headset },
  { key: "project", label: "Project", icon: SI.folder },
];
// The page's tabs (?t= in the address, Types when none): one job each, so no
// screen carries every switch at once.
type Tab = "types" | "rules" | "checklists" | "scheduling" | "review" | "teams";
// the tabs that show the type list, each with its own columns
type RowTab = "types" | "rules" | "checklists" | "scheduling";
const TABS: { k: Tab; l: string; d: string }[] = [
  { k: "types", l: "Types", d: "Names, sub-types, points and time" },
  { k: "rules", l: "Rules", d: "Goal, link, next step, self close and metric, for each type" },
  { k: "checklists", l: "Checklists", d: "The steps every task of a type starts with" },
  { k: "scheduling", l: "Scheduling", d: "What counts as a Schedule job" },
  { k: "review", l: "Review", d: "Who else reviews work that waits" },
  { k: "teams", l: "Teams & breaks", d: "Ads teams and breaks" },
];
// Matches the server's daily break cap (routes/breaks.js).
const BREAK_MINUTES = 75;
const trim = (n: number) => String(Math.round(n * 100) / 100);
// "A, B and C"
const andWords = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

// Saves `value` a moment after it last changed, unless it already matches what's
// saved — so three quick clicks on + make one request, not three.
function useAutoSave<T>(value: T, saved: T, save: (v: T) => void, delay = 700) {
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (value === saved) return;
    const t = setTimeout(() => saveRef.current(value), delay);
    return () => clearTimeout(t);
  }, [value, saved, delay]);
}

export function TaskRulesSection() {
  const { hasPermission, pageRule } = useWorkspaces();
  const canManage = hasPermission("task_settings");
  // See without Change (Settings › Page access): the lists, every control off
  const canLook = canManage || pageRule("setTasks", "see", false);
  // what a type is worth is the Super Admin's call; admins see the points
  const canPoints = useIsSuper();
  const { contentFormats, refetch: refetchFormats } = useContentFormats();
  const [rules, setRules] = useState<TaskTimeRule[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState<Cat>("social");
  const [newIcon, setNewIcon] = useState("🔧");
  // the main type a new type goes under ("" on its own)
  const [newParent, setNewParent] = useState("");
  const [adding, setAdding] = useState(false);
  // Scheduling tab: making each kind its own schedule goal type
  const [making, setMaking] = useState(false);
  // main types showing their sub-types
  const folds = useFolds();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.k === params.get("t"))?.k ?? "types";
  const pickTab = (k: Tab) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (k === "types") next.delete("t"); else next.set("t", k);
    return next;
  }, { replace: true });
  // does each scheduled Social task count as a Schedule job (Scheduling tab)?
  // (one copy for the page: the Scheduling card saves through it, so the list below follows)
  const { org, refetch: refetchOrg } = useOrg();
  const jobsOn = !!org?.scheduling?.perPostJob;

  const load = useCallback(() => {
    api<{ rules: TaskTimeRule[] }>("/task-time-rules")
      .then(({ rules }) => setRules(rules))
      .catch(() => setRules([]));
  }, []);
  useEffect(() => { if (canLook) load(); }, [canLook, load]);

  if (!canLook) {
    return (
      <section className="st-card">
        <div className="st-empty">
          Only admins can manage task types and how much time a task gets. When you create or work on a task, its type list and
          countdown follow whatever your admin set here.
        </div>
      </section>
    );
  }

  async function setRule(contentFormatId: string, editorId: string | null, hours: number) {
    try {
      await api("/task-time-rules", { method: "POST", body: JSON.stringify({ contentFormatId, editorId, hours }) });
      toast.success(editorId ? "Their time saved." : "Time budget saved.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the time.");
    }
  }
  async function removeRule(id: string, quiet = false) {
    try {
      await api(`/task-time-rules/${id}`, { method: "DELETE" });
      if (!quiet) toast.success("Timer removed.");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not clear that time.");
    }
  }
  async function patchFormat(id: string, patch: Record<string, unknown>, errorMsg: string, okMsg?: string | ((r: { schedulingMoved?: number }) => string)) {
    try {
      const r = await api<{ schedulingMoved?: number }>(`/content-formats/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refetchFormats();
      if (okMsg) toast.success(typeof okMsg === "function" ? okMsg(r) : okMsg);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : errorMsg);
      return false;
    }
  }
  async function addFormat() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      const under = (contentFormats ?? []).find((x) => x.id === newParent);
      await api("/content-formats", { method: "POST", body: JSON.stringify({ name, icon: newIcon, category: newCat, ...(under ? { parent_id: under.id } : {}) }) });
      if (under) folds.show(under.id);
      await refetchFormats();
      toast.success(`${name} added${under ? ` under ${under.name}` : ""} · now on New task and Goals.`);
      setNewName("");
      setNewIcon("🔧");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add that task type.");
    } finally {
      setAdding(false);
    }
  }
  async function moveFormat(f: ContentFormatDef, category: Cat) {
    const to = CATS.find((c) => c.key === category)?.label ?? category;
    const from = CATS.find((c) => c.key === f.category)?.label ?? f.category;
    const subs = (contentFormats ?? []).filter((x) => x.parent_id === f.id).length;
    const main = (contentFormats ?? []).find((x) => x.id === f.parent_id);
    if (!window.confirm(`Move "${f.name}" from ${from} to ${to}? New tasks of this type are made as ${to}; tasks already made stay ${from}.`
      + (subs ? ` Its ${kindsWord(subs)} move with it.` : main ? ` It stops being a sub-type of ${main.name}.` : ""))) return;
    await patchFormat(f.id, { category }, "Could not change the category.", `${f.name} moved to ${to}.`);
  }
  async function removeFormat(f: ContentFormatDef) {
    const subs = (contentFormats ?? []).filter((x) => x.parent_id === f.id).length;
    if (!window.confirm(`Remove "${f.name}"? Tasks and rules already using it keep working — it just won't be offered for new ones.`
      + (subs ? ` Its ${kindsWord(subs)} stay, each on its own.` : ""))) return;
    try {
      await api(`/content-formats/${f.id}`, { method: "DELETE" });
      await refetchFormats();
      toast.success(`${f.name} removed.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that task type.");
    }
  }

  const formats = contentFormats ?? [];
  const globalFor = (f: ContentFormatDef) => rules?.find((r) => r.content_format_id === f.id && !r.editor_id) ?? null;
  const parentOf = (id: string) => formats.find((x) => x.id === id)?.parent_id;
  // the database has sub-types (parent_id comes with 20261114120000_type_parent)
  const parentReady = formats.some((f) => f.parent_id !== undefined);
  // the org's Schedule type (server/src/scheduling.js scheduleFormat)
  const scheduleType = formats.find((f) => ["schedule", "scheduling"].includes(f.name.trim().toLowerCase())) ?? null;
  // how many types have a checklist (the Checklists tab says it)
  const checkCount = formats.filter((f) => (f.checklist?.length ?? 0) > 0).length;
  // what a main type's row shows: its sub-types added up
  const totalsOf = (subs: ContentFormatDef[]): SubTotals | null => (!subs.length ? null : {
    n: subs.length,
    points: subs.reduce((n, s) => n + Number(s.points ?? 0), 0),
    hours: subs.reduce((n, s) => n + Number(globalFor(s)?.hours ?? 0), 0),
    days: subs.reduce((n, s) => n + (s.duration_days ?? 0), 0),
    goal: subs.filter((s) => s.counts_in_goal).length,
    link: subs.filter((s) => s.review_link_required).length,
    sched: subs.filter((s) => s.to_scheduling).length,
    self: subs.filter((s) => s.self_close).length,
    jobable: subs.filter((s) => s.to_scheduling).length,
    checks: subs.filter((s) => (s.checklist?.length ?? 0) > 0).length,
  });
  function setParent(f: ContentFormatDef, parent_id: string | null) {
    const to = formats.find((x) => x.id === parent_id);
    if (to) folds.show(to.id);
    patchFormat(f.id, { parent_id }, "Could not change its main type.", to ? `${f.name} is a sub-type of ${to.name} now.` : `${f.name} is on its own now.`);
  }
  // Scheduling tab: what scheduling a Social type's work counts as — a schedule
  // type (Reels → Reels schedule), or nothing. The choices: the schedule types
  // (lib/schedule-types.ts), but not a main type with sub-types: they take the jobs.
  const isHead = (id: string) => formats.some((s) => s.parent_id === id);
  const schedIds = scheduleTypeIds(formats);
  const scheduleOptions = formats.filter((f) => schedIds.has(f.id) && !isHead(f.id));
  // with none named, the Schedule type takes it, as before (unless it's a heading now)
  const defaultScheduleId = scheduleType && !isHead(scheduleType.id) ? scheduleType.id : null;
  // what a type's scheduling counts as now: "none", a schedule type's id, or "" (nothing it can count as: pick one)
  const countsOf = (f: ContentFormatDef): string => !f.to_scheduling || f.schedule_job === false ? "none"
    : f.schedule_as ? (scheduleOptions.some((o) => o.id === f.schedule_as) ? f.schedule_as : "") : defaultScheduleId ?? "";
  // a main type's: its sub-types' that go to Scheduling, when they agree
  const countsOfGroup = (subs: ContentFormatDef[]): string => {
    const vals = [...new Set(subs.filter((s) => s.to_scheduling).map(countsOf))];
    return vals.length === 1 ? vals[0] : vals.length ? "mixed" : "none";
  };
  // Each kind its own goal: a Social type that goes to Scheduling (a main type:
  // its sub-types that do) gets "<name> schedule", a type next to Schedule, and
  // its scheduling counts as it — so Goals › Set goals has a row for it, where
  // each scheduler is given its count. A kind already set not to count is left.
  const socialGroups = groupTypes(formats.filter((f) => f.category === "social"), (f) => f.id, parentOf)
    .map((g) => ({ main: g.main, members: (g.subs.length ? g.subs : [g.main]).filter((s) => s.to_scheduling) }))
    .filter((g) => g.members.length > 0);
  const ownName = (f: ContentFormatDef) => `${f.name.trim().slice(0, 31)} schedule`;
  const ownTypeOf = (f: ContentFormatDef) => formats.find((x) => x.name.trim().toLowerCase() === ownName(f).toLowerCase()) ?? null;
  const missingOwn = socialGroups.filter((g) => !ownTypeOf(g.main) && !g.members.every((m) => countsOf(m) === "none"));
  async function giveOwnGoals(groups: typeof socialGroups) {
    if (!groups.length) return;
    setMaking(true);
    const done: string[] = [];
    try {
      for (const g of groups) {
        let own = ownTypeOf(g.main);
        if (!own) {
          const r = await api<{ contentFormat: ContentFormatDef }>("/content-formats", { method: "POST",
            body: JSON.stringify({ name: ownName(g.main), category: scheduleType?.category ?? "service", icon: scheduleType?.icon ?? "🗓️" }) });
          own = r.contentFormat;
        }
        const id = own.id;
        await Promise.all(g.members.map((m) => api(`/content-formats/${m.id}`, { method: "PATCH", body: JSON.stringify({ schedule_job: true, schedule_as: id }) })));
        done.push(own.name);
      }
      toast.success(`${andWords(done)} ${done.length === 1 ? "is" : "are"} ready: give each scheduler their count in Goals › Set goals.`
        + (jobsOn ? "" : " Switch on “Each Social task scheduled counts as a Schedule job” above, so scheduling counts toward them."));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not make that.");
    } finally {
      await refetchFormats();
      setMaking(false);
    }
  }
  // A main type's choice sets each of its sub-types that goes to Scheduling.
  // "new": the kind gets its own goal (above).
  async function setCountsAs(f: ContentFormatDef, subs: ContentFormatDef[] | null, value: string) {
    if (value === "new") { const g = socialGroups.find((x) => x.main.id === f.id); if (g) await giveOwnGoals([g]); return; }
    const targets = subs ? subs.filter((s) => s.to_scheduling) : [f];
    if (!targets.length || !value || value === "mixed") return;
    const body = value === "none" ? { schedule_job: false } : { schedule_job: true, schedule_as: value };
    const to = value === "none" ? null : formats.find((x) => x.id === value)?.name ?? "that";
    try {
      await Promise.all(targets.map((s) => api(`/content-formats/${s.id}`, { method: "PATCH", body: JSON.stringify(body) })));
      const who = !subs ? `Scheduling ${f.name}` : targets.length === 1 ? `${f.name}'s sub-type` : `All ${targets.length} of ${f.name}'s sub-types`;
      const many = !!subs && targets.length > 1;
      toast.success(to ? `${who} ${many ? "count" : "counts"} as ${to} now.` : `${who} ${many ? "don't" : "doesn't"} count as a schedule job now.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      await refetchFormats();
    }
  }

  // The type list as a tab shows it: each category (Scheduling: Social only), the
  // sub-types folded under their main type, and that tab's columns.
  const HEADS: Record<RowTab, ReactNode> = {
    types: <><span className="st-c-pts">Points</span><span className="st-c-time">Time</span><span className="st-c-del" /></>,
    rules: <>
      <span className="st-c-goal">Goal</span><span className="st-c-link">Link</span><span className="st-c-sched">Next step</span>
      <span className="st-c-self">Self close</span><span className="st-c-metric">Metric</span>
    </>,
    checklists: <span className="st-c-check">Checklist</span>,
    scheduling: <><span className="st-c-flow">Goes to Scheduling</span><span className="st-c-as">Counts as</span></>,
  };
  const typeTable = (tab: RowTab) => (
    <>
      <div className={"st-tt-head t-" + tab} aria-hidden="true"><span>Type</span>{HEADS[tab]}</div>
      {contentFormats === null || rules === null ? (
        <div className="st-empty">Loading…</div>
      ) : formats.length === 0 ? (
        <div className="st-empty">No task types yet{tab === "types" ? " — add the first one below." : ". Add them on Types."}</div>
      ) : CATS.filter((c) => tab !== "scheduling" || c.key === "social").map((c) => {
          const rows = formats.filter((f) => f.category === c.key);
          if (!rows.length) return null;
          return (
            <Fragment key={c.key}>
              <div className="st-ttgroup">{c.icon}{c.label}<span className="st-count">{rows.length}</span></div>
              {groupTypes(rows, (f) => f.id, parentOf).flatMap((g) => [g.main, ...(folds.isOpen(g.main.id) ? g.subs : [])].map((f) => (
                <TypeRow
                  key={f.id}
                  tab={tab}
                  jobsOn={jobsOn}
                  scheduleOptions={scheduleOptions}
                  newOwn={tab === "scheduling" && f === g.main && !ownTypeOf(f) ? ownName(f) : null}
                  countsAs={f === g.main && g.subs.length ? countsOfGroup(g.subs) : countsOf(f)}
                  onCountsAs={(v) => setCountsAs(f, f === g.main && g.subs.length ? g.subs : null, v)}
                  format={f}
                  sub={f !== g.main}
                  subCount={f === g.main ? g.subs.length : 0}
                  totals={f === g.main ? totalsOf(g.subs) : null}
                  open={folds.isOpen(f.id)}
                  onFold={() => folds.toggle(f.id)}
                  mains={rows.filter((m) => !m.parent_id && m.id !== f.id)}
                  onParent={(parent_id) => setParent(f, parent_id)}
                  rule={globalFor(f)}
                  canPoints={canPoints}
                  onCategory={(category) => moveFormat(f, category)}
                  onIcon={(icon) => patchFormat(f.id, { icon }, "Could not change the icon.")}
                  onRename={(name) => patchFormat(f.id, { name }, "Could not rename that type.", "Renamed.")}
                  onPoints={(points) => patchFormat(f.id, { points }, "Could not save points.", `${f.name}: ${trim(points)} point${points === 1 ? "" : "s"}.`)}
                  onMetric={(metric_tier) => patchFormat(f.id, { metric_tier }, "Could not update the metric tag.", "Metric tag saved.")}
                  onGoal={(counts_in_goal) => {
                    const n = f.goal_people ?? 0;
                    if (!counts_in_goal && n > 0 && !window.confirm(`${n} ${n === 1 ? "person has" : "people have"} a ${f.name} goal this month. Taking ${f.name} out of goals stops those goals counting, and ${f.name} tasks given to someone count as Other work instead. Take it out?`)) return;
                    patchFormat(f.id, { counts_in_goal }, "Could not update the goal setting.",
                      counts_in_goal ? `${f.name} counts in goals again.` : `${f.name} is off-goal work now.`);
                  }}
                  onLink={(review_link_required) => patchFormat(f.id, { review_link_required }, "Could not update the review link setting.",
                    review_link_required ? "A link is now needed for review." : "No link needed for review now.")}
                  onSched={(to_scheduling) => patchFormat(f.id, { to_scheduling }, "Could not update the next step.", ({ schedulingMoved: n = 0 }) => {
                    const tasks = `${n} approved task${n === 1 ? "" : "s"}`;
                    const list = f.category === "ad" ? "Ad uploads" : "Scheduling";
                    if (f.category === "service") {
                      return to_scheduling
                        ? `Approved ${f.name} tasks now wait for a decision: a Reel, an Ad or both.`
                        : `Approved ${f.name} tasks no longer wait for a decision.`;
                    }
                    return to_scheduling
                      ? `Approved ${f.name} work now goes to ${list}.${n ? ` ${tasks} from this month added to the list.` : ""}`
                      : `${f.name} no longer goes to ${list}.${n ? ` ${tasks} still waiting left the list.` : ""}`;
                  })}
                  onSelfClose={(self_close) => patchFormat(f.id, { self_close }, "Could not update Self close.",
                    self_close ? `${f.name} work closes without review now: whoever did it completes it.` : `${f.name} work goes to Review again.`)}
                  onHours={(hours) => setRule(f.id, null, hours)}
                  onClearHours={() => { const r = globalFor(f); if (r) removeRule(r.id); }}
                  onDuration={(duration_days) => patchFormat(f.id, { duration_days }, "Could not save the duration.", "Duration saved.")}
                  onMetrics={(metrics_description) => patchFormat(f.id, { metrics_description }, "Could not save that note.")}
                  onChecklist={(checklist, ok) => patchFormat(f.id, { checklist }, "Could not save the checklist.", ok)}
                  onRemove={() => removeFormat(f)}
                />
              )))}
            </Fragment>
          );
        })}
    </>
  );

  return (
    <>
    <div className="st-tabs" role="tablist" aria-label="Tasks and time">
      {TABS.map((t) => (
        <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={tab === t.k ? "on" : ""} onClick={() => pickTab(t.k)} title={t.d}
          aria-label={t.k === "checklists" && checkCount > 0 ? `${t.l}, ${checkCount}` : t.l}>
          {t.l}
          {t.k === "checklists" && checkCount > 0 && <span className="st-tabn">{checkCount}</span>}
        </button>
      ))}
    </div>
    <LookOnly on={!canManage}>
      {tab === "types" && (
      <section className="st-card">
        <div className="st-cardhead">
          <span className="st-titleline"><b>Task types</b><span className="st-count">{formats.length}</span></span>
          <span>One list for the whole workspace. Points are what a finished job earns; time budget is how long the timer gives it. A change to points counts from now on: jobs already completed, and goals already set, keep the points they had.{canPoints ? "" : " Only a Super Admin can change points."} A type can go under a main type, as Video Carousel under Carousel: it keeps its own points, time and goals, and the lists fold it under the main type. A main type with sub-types is only a heading: its points and time are its sub-types' totals, and goals and new tasks go on its sub-types.</span>
          <span className="st-uses">
            <span>{SI.addTask}New task picker</span>
            <span>{SI.flag}Goal types</span>
            <span>{SI.groups}Team · Today</span>
            <span>{SI.stopwatch}Timer budget</span>
          </span>
        </div>
        {typeTable("types")}
        <div className="st-foot">
          <IconPicker value={newIcon} onPick={setNewIcon} />
          <input className="st-in grow" placeholder="New task type" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !adding) addFormat(); }} />
          <select className="st-in" value={newCat} onChange={(e) => { setNewCat(e.target.value as Cat); setNewParent(""); }} aria-label="Kind of work" style={{ width: 130 }}>
            {CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          {parentReady && (
            <select className="st-in" value={newParent} onChange={(e) => setNewParent(e.target.value)} aria-label="Main type" title="Add it as a sub-type of a main type, as Video Carousel under Carousel" style={{ width: 160 }}>
              <option value="">On its own</option>
              {formats.filter((f) => f.category === newCat && !f.parent_id).map((f) => <option key={f.id} value={f.id}>Under {f.name}</option>)}
            </select>
          )}
          <button type="button" className="st-btn pri" disabled={adding || !newName.trim()} onClick={addFormat}>{SI.plus}{adding ? "Adding…" : "Add"}</button>
        </div>
      </section>
      )}
      {tab === "types" && (
        <span className="st-note">
          Points — on or before the due date earns them in full, 1 day late half, 2 days none, 3 or more costs them back. Time — how long the timer
          gives a task of the type. Removing a type doesn't touch tasks already using it.
        </span>
      )}

      {tab === "rules" && (
        <>
          <section className="st-card">
            <div className="st-cardhead">
              <b>How each type's work goes</b>
              <span>Whether it counts in goals, what it needs before Review, where approved work goes next, and its metric tag.</span>
            </div>
            {typeTable("rules")}
          </section>
          <span className="st-note">
            Goal — the type is tracked in goals; off, it's not offered in Set goals and counts as Other work. Link — a task of this type can't go to review
            without a delivery link (untick it for scheduling, data or technical work). Next step — an approved Social task of this type goes to Scheduling,
            for its post date and links (untick it for thumbnails and other work that isn't posted on its own); an approved Ads task goes to Ad uploads, for
            the ad numbers it became; an approved Service task of the type is R&D (AI Job): a Manager or Team Lead decides whether it becomes a Reel, an Ad,
            both, or isn't used. Self close — whoever did the work moves it to Completed themselves, with no review (Schedule work, say).
          </span>
          <section className="st-card">
            <div className="st-cardhead">
              <b>Task rules</b>
              <span>How tasks work for everyone. These are always on for now.</span>
            </div>
            <RuleRow l="Create a task when an editor is assigned to a post" d="Title, channel and due date carry over and stay in sync" />
            <RuleRow l="Assignee accepts before work starts" d="A task someone else gives you waits as “Pending accept” until you take it" />
            <RuleRow l="Finished work goes to review first" d="Its reviewer approves it before it counts as completed, unless its type is Self close" />
            <RuleRow l="A checklist is finished before review" d="Every item, from its type's checklist or added by hand, is ticked before the work is handed in" />
            <RuleRow l="Flag tasks that pass their time budget" d="The timer turns red once a task runs past its time" />
          </section>
        </>
      )}

      {tab === "checklists" && (
        <section className="st-card">
          <div className="st-cardhead">
            <span className="st-titleline"><b>Checklists</b><span className="st-count">{checkCount}</span></span>
            <span>
              The steps every new task of a type starts with. Whoever does the task ticks each one before it goes to Review (or closes itself), and
              can't remove them; an admin, or whoever assigned the task, can. Tasks already made keep the checklist they have. A main type with
              sub-types has none of its own: set it on each sub-type.
            </span>
          </div>
          {typeTable("checklists")}
        </section>
      )}

      {tab === "scheduling" && (
        <>
          <SchedulingCard on={jobsOn} ready={!!org} refetch={refetchOrg} />
          <section className={"st-card" + (jobsOn ? "" : " st-dim")}>
            <div className="st-cardhead">
              <b>What each type's scheduling counts as</b>
              <span>
                {jobsOn
                  ? "Once its links are in, each Social task counts as one job of the schedule type picked here, for whoever scheduled it: Reels as Reels schedule, Story as Story schedule, so each kind has its own goal in Goals. Only types that go to Scheduling (Next step, on Rules) can count."
                  : "These count only while “Each Social task scheduled counts as a Schedule job” is on, above. You can set them now."}
                {" "}A main type's choice sets all its sub-types.
              </span>
            </div>
            {typeTable("scheduling")}
            {missingOwn.length > 0 && (
              <div className="st-foot">
                <span className="st-note">
                  {SI.info} Give each kind its own goal: {andWords(missingOwn.map((g) => ownName(g.main)))}, made next to Schedule. Each scheduler's
                  count for each is then set in Goals › Set goals, like any other type.
                </span>
                <button type="button" className="st-btn pri" disabled={making}
                  onClick={() => {
                    const names = andWords(missingOwn.map((g) => ownName(g.main)));
                    if (window.confirm(`Make ${names}? Scheduling each kind then counts as one job of its own type, and you give each scheduler their count for it in Goals › Set goals.`)) giveOwnGoals(missingOwn);
                  }}>
                  {SI.plus}{making ? "Making…" : "Give each its own goal"}
                </button>
              </div>
            )}
          </section>
          {scheduleOptions.length > 0 && (
            <section className="st-card">
              <div className="st-cardhead">
                <b>Schedule types</b>
                <span>
                  Each is a goal type like any other: every job earns its points, and Goals plans it as jobs × its time, so with each post a job, set the few
                  minutes one takes. Anyone with a goal on one of these this month is a scheduler. A change to points counts from now on: jobs already
                  done keep the points they had.
                </span>
              </div>
              {scheduleOptions.map((o) => (
                <ScheduleTypeRow key={o.id} format={o} rule={globalFor(o)} canPoints={canPoints}
                  onPoints={(points) => patchFormat(o.id, { points }, "Could not save points.", `${o.name}: ${trim(points)} point${points === 1 ? "" : "s"} a job.`)}
                  onHours={(h) => setRule(o.id, null, h)} onClearHours={() => { const r = globalFor(o); if (r) removeRule(r.id); }} />
              ))}
            </section>
          )}
        </>
      )}

      {tab === "review" && <ReviewHandoffCard />}

      {tab === "teams" && (
        <>
          <AdTeamsCard />
          <section className="st-card">
            <div className="st-cardhead"><b>Breaks</b></div>
            <div className="st-row">
              <span className="st-label">
                <b>Daily break allowance</b>
                <small>Lunch 45m and two tea breaks of 15m, the same for everyone · shown in the sidebar</small>
              </span>
              <span className="st-value st-mono">{fmtHours(BREAK_MINUTES / 60)} / day</span>
            </div>
            <RuleRow l="Pause the running timer during a break" d="Break time is added back to the task's time budget" />
          </section>
        </>
      )}
    </LookOnly>
    </>
  );
}

// Scheduling: does each post a scheduler links count as a Schedule job of
// theirs (server/src/routes/scheduling.js)? Off, the default: only their
// Schedule tasks count, such as a daily social-desk task; the posts stay
// listed on Scheduling either way.
// The time each schedule job plans in goals (a schedule type's time, Scheduling
// tab): with each post a job, a few minutes, in 5-minute steps up to an hour.
const minuteStep = (h: number | null, dir: 1 | -1) => {
  const m = h == null ? 0 : Math.round(h * 60);
  const next = dir > 0 ? m + (m < 60 ? 5 : 15) : m - (m <= 60 ? 5 : 15);
  return next <= 0 ? null : Math.min(999, Math.round((next / 60) * 100) / 100);
};
// One schedule type (Scheduling tab): its points, who has its goal, and the time
// each job plans in goals — the same time as on Types.
// A schedule job's points, in small steps (one post is quick work): 0.1 under a
// point, 0.5 up to 5, then whole points.
const pointStep = (p: number, dir: 1 | -1) => {
  const step = dir > 0 ? (p < 1 ? 0.1 : p < 5 ? 0.5 : 1) : (p <= 1 ? 0.1 : p <= 5 ? 0.5 : 1);
  return Math.min(1000, Math.max(0, Math.round((p + dir * step) * 100) / 100));
};
function ScheduleTypeRow({ format, rule, canPoints, onPoints, onHours, onClearHours }: {
  format: ContentFormatDef; rule: TaskTimeRule | null; canPoints: boolean; onPoints: (points: number) => void;
  onHours: (h: number) => void; onClearHours: () => void;
}) {
  const savedHours = rule?.hours != null ? Number(rule.hours) : null;
  const [hours, setHours] = useState<number | null>(savedHours);
  useEffect(() => setHours(savedHours), [savedHours]);
  useAutoSave(hours, savedHours, (h) => (h == null ? onClearHours() : onHours(h)));
  const savedPts = Number(format.points ?? 0);
  const [points, setPoints] = useState(savedPts);
  useEffect(() => setPoints(savedPts), [savedPts]);
  useAutoSave(points, savedPts, onPoints);
  const goals = format.goal_people ? `In ${format.goal_people} ${format.goal_people === 1 ? "person's" : "people's"} goals` : "In nobody's goals yet";
  return (
    <div className="st-row st-schedrow">
      <span className="st-label">
        <b>{format.icon} {format.name}</b>
        <small>{goals}{canPoints ? "" : " · only a Super Admin changes points"}</small>
      </span>
      <span className="st-schedctl">
        <small>Points a job</small>
        <Stepper className="sm acc pts" label={`points for each ${format.name} job`} value={trim(points)}
          onDec={() => setPoints((p) => pointStep(p, -1))} onInc={() => setPoints((p) => pointStep(p, 1))}
          decDisabled={!canPoints || points <= 0} incDisabled={!canPoints} />
      </span>
      <span className="st-schedctl">
        <small>Time a job</small>
        <Stepper className={"sm time" + (hours == null ? " none" : "")} label={`time for each ${format.name} job`} value={hours == null ? "No timer" : fmtHours(hours)}
          onDec={() => setHours((h) => minuteStep(h, -1))} onInc={() => setHours((h) => minuteStep(h, 1))} decDisabled={hours == null} />
      </span>
    </div>
  );
}
function SchedulingCard({ on, ready, refetch }: { on: boolean; ready: boolean; refetch: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  async function set(next: boolean) {
    setBusy(true);
    try {
      await api("/org", { method: "PATCH", body: JSON.stringify({ scheduling: { perPostJob: next } }) });
      await refetch();
      toast.success(next ? "Each Social task scheduled counts as a Schedule job now." : "Only Schedule tasks count now. Scheduled work stays listed on Scheduling.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="st-card">
      <div className="st-cardhead"><b>Schedule jobs</b><span>What counts toward a scheduler's Schedule goal.</span></div>
      <div className="st-row">
        <span className="st-label">
          <b>Each Social task scheduled counts as a Schedule job</b>
          <small>On: once its links are in, each one counts as one job for whoever scheduled it, of the schedule type its type counts as (below). Off: only their Schedule tasks count, such as a daily 2-hour social-desk task. Scheduled work stays listed on Scheduling either way.</small>
        </span>
        <Toggle on={on} onChange={set} disabled={busy || !ready} label="Each Social task scheduled counts as a Schedule job" />
      </div>
    </section>
  );
}

// Review hand-offs (server/src/review-route.js): a task still waiting in Review
// can be reviewed by more people as the days go by: the Team Leads, then the
// Asst. Managers, then the Managers; each step sends them one bell notice.
// Each wait counts from handing in, and each one set comes after the one
// before. Team Leads: for work that has its own reviewer (Settings › Access ›
// Review tasks), off by default. Asst. Managers: off by default (they come
// with the Managers); none on the team → the Managers come at their time.
// Managers: after a day by default; Never keeps those tasks away from them.
const HANDOFF = [24, 48, 72, 120, 168];
const dayWords = (h: number) => `${h / 24} day${h === 24 ? "" : "s"}`;
type Handoffs = { leadHours: number | null; asstHours: number | null; managerHours: number | null };
const STEPS: { key: keyof Handoffs; name: string }[] = [
  { key: "leadHours", name: "Team Leads" }, { key: "asstHours", name: "Asst. Managers" }, { key: "managerHours", name: "Managers" },
];
function ReviewHandoffCard() {
  const { org, refetch } = useOrg();
  const { editors } = useEditors();
  const saved: Handoffs = { leadHours: null, asstHours: null, managerHours: 24, ...org?.review };
  // anyone in the Asst. Manager position? (none: the Managers come in their place)
  const hasAsst = (editors ?? []).some((e) => e.active !== false && positionKey(e.designation) === "asstManager");
  const [busy, setBusy] = useState(false);
  async function save(next: Handoffs, ok: string) {
    setBusy(true);
    try {
      await api("/org", { method: "PATCH", body: JSON.stringify({ review: next }) });
      await refetch();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }
  function set(key: keyof Handoffs, hours: number | null) {
    // the steps after it stay later: moved to the next wait when needed
    const next = { ...saved, [key]: hours };
    const moved: string[] = [];
    let prev = 0;
    for (const s of STEPS) {
      const h = next[s.key];
      if (h == null) continue;
      if (h <= prev) {
        next[s.key] = HANDOFF.find((x) => x > prev) ?? null;
        moved.push(next[s.key] == null ? `${s.name} set to ${s.key === "managerHours" ? "Never" : "Off"}.` : `${s.name} moved to after ${dayWords(next[s.key]!)}.`);
      }
      prev = next[s.key] ?? prev;
    }
    const name = STEPS.find((s) => s.key === key)!.name;
    const said = hours != null ? `${name} can review after ${dayWords(hours)}.`
      : key === "asstHours" ? "Asst. Managers come with the Managers now."
      : `${name} don't get waiting reviews now.`;
    save(next, [said, ...moved].join(" "));
  }
  const pick = (v: string) => (v === "" ? null : Number(v));
  // a step's choices: only waits after the steps before it that are set
  const after = (key: keyof Handoffs) => {
    const i = STEPS.findIndex((s) => s.key === key);
    return Math.max(0, ...STEPS.slice(0, i).map((s) => saved[s.key] ?? 0));
  };
  // the way a waiting task goes, in words: "its reviewer → after 1 day, Team Leads too → …"
  const flow = (first: string, withLeads: boolean) => {
    const asstOwn = saved.asstHours != null;
    const rest = [
      ...(withLeads && saved.leadHours != null ? [`after ${dayWords(saved.leadHours)}, Team Leads too`] : []),
      ...(asstOwn ? [`after ${dayWords(saved.asstHours!)}, ${hasAsst ? "Asst. Managers too" : "Managers too (no Asst. Manager yet)"}`] : []),
      ...(saved.managerHours != null && !(asstOwn && !hasAsst)
        ? [`after ${dayWords(saved.managerHours)}, ${asstOwn || !hasAsst ? "Managers" : "Managers and Asst. Managers"} too`] : []),
    ];
    return rest.length ? [first, ...rest].join(" → ") : `${first} only, however long it waits`;
  };
  const choose = (key: keyof Handoffs, label: string, none: string, noneFirst: boolean) => (
    <select className="st-in st-handoff" value={saved[key] ?? ""} disabled={busy || !org} aria-label={label}
      onChange={(e) => set(key, pick(e.target.value))}>
      {noneFirst && <option value="">{none}</option>}
      {HANDOFF.map((h) => <option key={h} value={h} disabled={h <= after(key)}>After {dayWords(h)}</option>)}
      {!noneFirst && <option value="">{none}</option>}
    </select>
  );
  return (
    <section className="st-card">
      <div className="st-cardhead">
        <b>Review hand-offs</b>
        <span>When a task waits too long in Review, who else can review it. Each wait counts from when the work was handed in, and each step sends them one bell notice, so a longer wait means fewer notices.</span>
      </div>
      <div className="st-row">
        <span className="st-label">
          <b>Team Leads</b>
          <small>For work that has its own reviewer (Settings › Access › Review tasks). An editor's other work goes to the Team Leads first anyway.</small>
        </span>
        {choose("leadHours", "When Team Leads can review a waiting task", "Off", true)}
      </div>
      <div className="st-row">
        <span className="st-label">
          <b>Asst. Managers</b>
          <small>
            {hasAsst ? "Before the Managers." : "No one is an Asst. Manager yet, so the Managers come in at this time in their place."} Off: Asst. Managers come with the Managers.
          </small>
        </span>
        {choose("asstHours", "When Asst. Managers can review a waiting task", "Off", true)}
      </div>
      <div className="st-row">
        <span className="st-label">
          <b>Managers</b>
          <small>Never: these tasks don't reach them, and only the people before them can close them.</small>
        </span>
        {choose("managerHours", "When Managers can review a waiting task", "Never", false)}
      </div>
      <div className="st-row sunk">
        <span className="st-label">
          <b>How it goes now</b>
          <small>Work with its own reviewer: {flow("its reviewer", true)}.</small>
          <small>An editor's other work: {flow("Team Leads", false)}.</small>
          <small>A task someone gave: the person who gave it, only. A Team Lead's own work of other types: Managers and Asst. Managers straight away.</small>
        </span>
      </div>
    </section>
  );
}

// One always-on rule: shown switched on, and locked.
function RuleRow({ l, d }: { l: string; d: string }) {
  return (
    <div className="st-row">
      <span className="st-label"><b>{l}</b><small>{d}</small></span>
      <span className="st-always">Always on</span>
      <Toggle on onChange={() => {}} disabled label={`${l} — always on`} />
    </div>
  );
}

// A small icon-swatch popover — click the current icon to pick a new one.
// Closes on an outside click or after picking. The settings card hides what
// spills past its edge, so near the bottom (New task type, the last type)
// it opens upward instead.
function IconPicker({ value, onPick }: { value: string; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) { setUp(false); return; }
    const pop = popRef.current?.getBoundingClientRect();
    const card = ref.current?.closest(".st-card")?.getBoundingClientRect();
    if (pop && card && pop.bottom > card.bottom - 4) setUp(true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  return (
    <div className="st-ic" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} title="Change icon" aria-label="Change icon" aria-expanded={open}>{value}</button>
      {open && (
        <div ref={popRef} className={"st-icpop" + (up ? " up" : "")} role="listbox" aria-label="Icons">
          {ICON_OPTIONS.map((ic) => (
            <button key={ic} type="button" role="option" aria-selected={ic === value} className={ic === value ? "on" : ""} onClick={() => { onPick(ic); setOpen(false); }}>{ic}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// A main type's sub-types added up: points, time (or days), and how many have each switch on.
type SubTotals = {
  n: number; points: number; hours: number; days: number; goal: number; link: number; sched: number; self: number;
  // Scheduling tab: how many go to Scheduling; Checklists: how many have one
  jobable: number; checks: number;
};
// How many of its sub-types have a switch on, in place of the switch.
const SubCount = ({ n, of, what }: { n: number; of: number; what: string }) => (
  <span className="st-total plain" title={`Sub-types ${what}: ${n} of ${of}. Set it on each of them.`}>{n} / {of}</span>
);

// One task type, as a tab shows it. Types: icon, name (click to rename),
// category, main type, points and time (or duration). Rules: goal, link, next
// step, self close and metric tag. Checklists: its steps. Scheduling: whether
// scheduling its work counts as a Schedule job. Every field saves on its own. A
// main type with sub-types (`totals`) is only a heading: it keeps its name, icon
// and category, and the rest shows what's on its sub-types.
function TypeRow({
  tab, jobsOn, scheduleOptions, newOwn = null, countsAs, onCountsAs,
  format, sub = false, subCount = 0, totals = null, open = false, onFold, mains, onParent,
  rule, canPoints, onCategory, onIcon, onRename, onPoints, onMetric, onGoal, onLink, onSched, onSelfClose, onHours, onClearHours, onDuration, onMetrics, onChecklist, onRemove,
}: {
  tab: RowTab;
  // Scheduling tab: does each scheduled Social task count as a job; what this
  // type's scheduling counts as ("none", a schedule type's id, "" none it can,
  // "mixed" sub-types that differ), and the schedule types it can count as
  jobsOn: boolean;
  scheduleOptions: ContentFormatDef[];
  // a main row's own schedule type still to make ("Reels schedule"), offered as "+ New"
  newOwn?: string | null;
  countsAs: string;
  onCountsAs: (value: string) => void;
  format: ContentFormatDef;
  // a sub-type (indented under its main type); a main type's sub-types, shown or folded
  sub?: boolean;
  subCount?: number;
  totals?: SubTotals | null;
  open?: boolean;
  onFold?: () => void;
  // the types it could go under: this category's main types
  mains: ContentFormatDef[];
  onParent: (parentId: string | null) => void;
  rule: TaskTimeRule | null;
  canPoints: boolean;
  onCategory: (category: Cat) => void;
  onIcon: (icon: string) => void;
  onRename: (name: string) => void;
  onPoints: (points: number) => void;
  onMetric: (tier: "key" | "critical" | null) => void;
  onGoal: (on: boolean) => void;
  onLink: (required: boolean) => void;
  onSched: (on: boolean) => void;
  onSelfClose: (on: boolean) => void;
  onHours: (hours: number) => void;
  onClearHours: () => void;
  onDuration: (days: number | null) => void;
  onMetrics: (text: string | null) => void;
  onChecklist: (list: string[], ok: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const isProject = format.category === "project";
  // its checklist, shown under the row (a main type with sub-types has none: its sub-types do)
  const [checksOpen, setChecksOpen] = useState(false);
  const steps = format.checklist?.length ?? 0;
  const hasChecks = format.checklist !== undefined && !totals;
  const [name, setName] = useState(format.name);
  const [metrics, setMetrics] = useState(format.metrics_description ?? "");
  const [points, setPoints] = useState(Number(format.points));
  const savedHours = rule?.hours != null ? Number(rule.hours) : null;
  const [hours, setHours] = useState<number | null>(savedHours);
  const [days, setDays] = useState<number | null>(format.duration_days ?? null);

  useEffect(() => setName(format.name), [format.name]);
  useEffect(() => setMetrics(format.metrics_description ?? ""), [format.metrics_description]);
  useEffect(() => setPoints(Number(format.points)), [format.points]);
  useEffect(() => setHours(savedHours), [savedHours]);
  useEffect(() => setDays(format.duration_days ?? null), [format.duration_days]);

  useAutoSave(points, Number(format.points), onPoints);
  useAutoSave(hours, savedHours, (h) => (h == null ? onClearHours() : onHours(h)));
  useAutoSave(days, format.duration_days ?? null, onDuration);

  function saveName() {
    const t = name.trim();
    if (!t || t === format.name) { setName(format.name); return; }
    onRename(t);
  }
  function saveMetrics() {
    const next = metrics.trim() || null;
    if (next !== (format.metrics_description ?? null)) onMetrics(next);
  }
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };
  // the goal note under the name (shortened to fit; its full text on hover)
  const goalNote = !format.counts_in_goal ? "Not tracked in goals"
    : format.goal_people ? `In ${format.goal_people} ${format.goal_people === 1 ? "person's" : "people's"} goals` : "Tracked in goals";

  // a main type's sub-types, shown or folded (on every tab)
  const fold = subCount > 0 && (
    <button type="button" className="st-tt-fold" aria-expanded={open} onClick={onFold} title={open ? "Hide its sub-types" : "Show its sub-types"}>
      {kindsWord(subCount)} {open ? "▴" : "▾"}
    </button>
  );
  const preview = (format.checklist ?? []).join(" · ");

  return (
    <>
    <div className={"st-tt t-" + tab + (sub ? " sub" : "") + (checksOpen && hasChecks ? " checks-open" : "")}>
      {tab === "types" ? (
        <span className="st-tt-name">
          <IconPicker value={format.icon} onPick={onIcon} />
          <span>
            <input className="st-plain" value={name} aria-label="Name" onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={blurOnEnter} />
            <span className="st-tt-sub">
              <select className="st-kind" value={format.category ?? "social"} aria-label={`${format.name} category`} title="Change the category"
                onChange={(e) => onCategory(e.target.value as Cat)}>
                {CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              {fold || (format.parent_id !== undefined && (mains.length > 0 || format.parent_id) ? (
                <select className={"st-kind" + (format.parent_id ? "" : " none")} value={format.parent_id ?? ""} aria-label={`${format.name} main type`} title="Put it under a main type, as Video Carousel under Carousel"
                  onChange={(e) => onParent(e.target.value || null)}>
                  <option value="">{format.parent_id ? "On its own" : "Put under…"}</option>
                  {mains.map((m) => <option key={m.id} value={m.id}>Under {m.name}</option>)}
                </select>
              ) : null)}
              {isProject && (
                <input className="st-metrics" value={metrics} placeholder="What this project delivers (a note, not scored)…" aria-label={`What ${format.name} delivers`}
                  onChange={(e) => setMetrics(e.target.value)} onBlur={saveMetrics} onKeyDown={blurOnEnter} />
              )}
            </span>
          </span>
        </span>
      ) : (
        <span className="st-tt-name">
          <div className="st-ic"><span className="st-ic-face" aria-hidden="true">{format.icon}</span></div>
          <span>
            <b className="st-tt-title">{format.name}</b>
            <span className="st-tt-sub">
              {fold}
              {tab === "rules" && format.counts_in_goal !== undefined && !totals && (
                <small className={"st-tt-goal" + (format.counts_in_goal ? "" : " off")} title={goalNote}>{goalNote}</small>
              )}
              {tab === "checklists" && (totals
                ? <small>{totals.checks ? `${totals.checks} of ${totals.n} have a checklist` : "Set it on each sub-type"}</small>
                : <small className={preview ? "" : "st-tt-goal off"} title={preview || undefined}>{preview || "No steps yet"}</small>)}
              {tab === "scheduling" && !totals && format.to_scheduling === false && <small className="st-tt-goal off">Next step is off, so it doesn't go to Scheduling</small>}
            </span>
          </span>
        </span>
      )}
      {tab === "checklists" && (
        <span className="st-c-check">
          {totals ? <span className="st-note" title="A main type with sub-types is only a heading">—</span>
            : hasChecks ? (
              <button type="button" className={"st-btn sm st-checkbtn" + (steps ? "" : " none")} aria-expanded={checksOpen} onClick={() => setChecksOpen((v) => !v)}
                title={steps ? `Every new ${format.name} task starts with ${steps} step${steps === 1 ? "" : "s"}` : `Add the steps every ${format.name} task starts with`}>
                {steps ? `☑ ${steps} step${steps === 1 ? "" : "s"}` : "+ Add steps"} {checksOpen ? "▴" : "▾"}
              </button>
            ) : <span className="st-note" title="Needs the database update 20261117120000_type_checklist">—</span>}
        </span>
      )}
      {tab === "scheduling" && (
        <>
          <span className="st-c-flow">
            <span className="st-mlabel">Goes to Scheduling</span>
            {totals ? <SubCount n={totals.jobable} of={totals.n} what="that go to Scheduling" />
              : format.to_scheduling === undefined ? <span className="st-note">—</span>
              : <span className={"st-flag" + (format.to_scheduling ? " on" : "")}>{format.to_scheduling ? "Yes" : "No"}</span>}
          </span>
          <span className={"st-c-as" + (jobsOn ? "" : " idle")}>
            <span className="st-mlabel">Counts as</span>
            {format.schedule_as === undefined ? <span className="st-note" title="Needs the database updates 20261118120000_type_schedule_job and 20261118130000_type_schedule_as">—</span>
              : (totals ? !totals.jobable : !format.to_scheduling) ? <span className="st-note" title="Its work doesn't go to Scheduling">—</span>
              : (
                <select className={"st-in st-counts" + (countsAs === "" ? " warn" : countsAs === "none" ? " none" : "")} value={countsAs}
                  aria-label={totals ? `What scheduling ${format.name}'s sub-types counts as` : `What scheduling ${format.name} counts as`}
                  title={totals ? `Sets it on all ${format.name}'s sub-types that go to Scheduling` : undefined}
                  onChange={(e) => onCountsAs(e.target.value)}>
                  {countsAs === "" && <option value="" disabled>Pick one…</option>}
                  {countsAs === "mixed" && <option value="mixed" disabled>Mixed</option>}
                  <option value="none">Doesn't count</option>
                  {scheduleOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  {newOwn && <option value="new">+ New: {newOwn}</option>}
                </select>
              )}
          </span>
        </>
      )}
      {tab === "rules" && (<>
      <span className="st-c-goal">
        <span className="st-mlabel">Goal</span>
        {totals ? <SubCount n={totals.goal} of={totals.n} what="that count in goals" />
          : format.counts_in_goal !== undefined
          ? <Toggle on={format.counts_in_goal} onChange={onGoal} label={`${format.name} counts in goals`} />
          : <span className="st-note" title="Needs the database update 20261110120000_type_counts_in_goal">—</span>}
      </span>
      <span className="st-c-link">
        <span className="st-mlabel">Link</span>
        {totals ? <SubCount n={totals.link} of={totals.n} what="that need a delivery link" />
          : <Toggle on={format.review_link_required} onChange={onLink} label={`${format.name} needs a delivery link for review`} />}
      </span>
      <span className="st-c-sched">
        {(format.category === "social" || format.category === "ad" || format.category === "service") && format.to_scheduling !== undefined ? (
          <><span className="st-mlabel">{format.category === "ad" ? "Ad uploads" : format.category === "service" ? "Reel / Ad" : "Scheduling"}</span>
            {totals ? <SubCount n={totals.sched} of={totals.n} what="that go on after approval" /> : <Toggle on={format.to_scheduling} onChange={onSched}
              label={format.category === "service"
                ? `Approved ${format.name} tasks wait for a decision: a Reel, an Ad or both`
                : `Approved ${format.name} work goes to ${format.category === "ad" ? "Ad uploads" : "Scheduling"}`} />}</>
        ) : <span className="st-note" style={{ justifyContent: "center" }}
          title={format.category === "social" || format.category === "ad" || format.category === "service" ? "Needs the scheduling database update" : "Only Social, Ads and Service work goes on after approval"}>—</span>}
      </span>
      <span className="st-c-self">
        <span className="st-mlabel">Self close</span>
        {totals ? <SubCount n={totals.self} of={totals.n} what="that close without review" />
          : format.self_close !== undefined
          ? <Toggle on={format.self_close} onChange={onSelfClose} label={`${format.name} work closes without review`} />
          : <span className="st-note" title="Needs the database update 20261116120000_type_self_close">—</span>}
      </span>
      <span className="st-c-metric">
        {!isProject && <span className="st-mlabel">Metric</span>}
        {isProject || totals ? <span className="st-note" style={{ justifyContent: "center" }} title={totals ? "Each sub-type has its own metric tag" : undefined}>—</span> : (
          <select className="st-in" value={format.metric_tier ?? ""} onChange={(e) => onMetric((e.target.value || null) as "key" | "critical" | null)}
            aria-label={`${format.name} metric tag`} title="Tag it as a Key or Critical metric for Management Performance">
            <option value="">None</option>
            <option value="key">Key</option>
            <option value="critical">Critical</option>
          </select>
        )}
      </span>
      </>)}
      {tab === "types" && (<>
      <span className="st-c-pts">
        <span className="st-mlabel">Points</span>
        {totals ? (
          <span className="st-total" title={`Added up from its ${kindsWord(totals.n)}. Set the points on each of them.`}><small>Total</small>{trim(totals.points)}</span>
        ) : (
          <Stepper className="sm acc pts" label={`points for ${format.name}`} value={trim(points)}
            onDec={() => setPoints((p) => Math.max(0, Math.round((p - 1) * 100) / 100))} onInc={() => setPoints((p) => Math.min(1000, Math.round((p + 1) * 100) / 100))}
            decDisabled={!canPoints || points <= 0} incDisabled={!canPoints} />
        )}
      </span>
      <span className="st-c-time">
        <span className="st-mlabel">{isProject ? "Days" : "Time"}</span>
        {totals ? (
          <span className="st-total" title={`Added up from its ${kindsWord(totals.n)}. Set the ${isProject ? "days" : "time"} on each of them.`}>
            <small>Total</small>
            {isProject
              ? (totals.days ? `${totals.days} day${totals.days === 1 ? "" : "s"}` : "No limit")
              : (totals.hours ? fmtHours(totals.hours) : "No timer")}
          </span>
        ) : isProject ? (
          <Stepper className={"sm time" + (days == null ? " none" : "")} label={`days for ${format.name}`} value={days == null ? "No limit" : `${days} day${days === 1 ? "" : "s"}`}
            onDec={() => setDays((d) => (d == null || d <= 1 ? null : d - 1))} onInc={() => setDays((d) => Math.min(3650, (d ?? 0) + 1))} decDisabled={days == null} />
        ) : (
          <Stepper className={"sm time" + (hours == null ? " none" : "")} label={`time for ${format.name}`} value={hours == null ? "No timer" : fmtHours(hours)}
            onDec={() => setHours((h) => (h == null || h <= 0.25 ? null : h - 0.25))} onInc={() => setHours((h) => Math.min(999, h == null ? 0.5 : h + 0.25))} decDisabled={hours == null} />
        )}
      </span>
      <span className="st-c-del">
        <button type="button" className="st-icobtn" onClick={onRemove} title="Remove" aria-label={`Remove ${format.name}`}>{SI.trash}</button>
      </span>
      </>)}
    </div>
    {tab === "checklists" && checksOpen && hasChecks && <ChecklistEditor format={format} sub={sub} onSave={onChecklist} />}
    </>
  );
}

// A type's checklist (Settings › Tasks & time): the steps every new task of the
// type starts with, in order. Whoever does the task ticks each one before it
// goes to Review (or closes itself), and can't remove them; an admin or whoever
// assigned it can (server/src/routes/tasks.js). Each change saves on its own.
// Tasks already made keep the checklist they have.
const CHECK_MAX = 30;
function ChecklistEditor({ format, sub, onSave }: { format: ContentFormatDef; sub: boolean; onSave: (list: string[], ok: string) => Promise<boolean> }) {
  const savedKey = JSON.stringify(format.checklist ?? []);
  const [items, setItems] = useState<string[]>(format.checklist ?? []);
  const [draft, setDraft] = useState("");
  // bumped to put the step inputs back to what's saved
  const [ver, setVer] = useState(0);
  const reset = () => { setItems(JSON.parse(savedKey) as string[]); setVer((v) => v + 1); };
  useEffect(() => setItems(JSON.parse(savedKey) as string[]), [savedKey]);
  const save = async (next: string[], ok: string) => {
    setItems(next);
    if (!(await onSave(next, ok))) reset();
  };
  const has = (t: string, except = -1) => items.some((x, k) => k !== except && x.toLowerCase() === t.toLowerCase());
  function add() {
    const t = draft.trim().replace(/\s+/g, " ");
    if (!t) return;
    if (has(t)) { toast.error("That step is on the list already."); return; }
    save([...items, t], `${format.name}: step ${items.length + 1} added.`);
    setDraft("");
  }
  function rename(i: number, value: string) {
    const t = value.trim().replace(/\s+/g, " ");
    if (t === items[i]) return;
    if (!t || has(t, i)) { if (t) toast.error("That step is on the list already."); reset(); return; }
    save(items.map((x, k) => (k === i ? t : x)), `${format.name}: step ${i + 1} renamed.`);
  }
  function move(i: number, by: number) {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    save(next, `${format.name}: order saved.`);
  }
  const when = format.self_close ? "before it's completed" : "before it goes to Review";
  return (
    <div className={"st-tt-checks" + (sub ? " sub" : "")}>
      <span className="st-tt-checkhead">
        <b>{format.name} checklist</b>
        <small>Every new {format.name} task starts with these steps. Whoever does it ticks each one {when}, and can't remove them. Tasks already made keep the checklist they have.</small>
      </span>
      {items.length > 0 && (
        <ol className="st-checks">
          {items.map((s, i) => (
            <li key={`${ver}:${i}:${s}`}>
              <span className="st-check-n">{i + 1}</span>
              <input className="st-check-in" defaultValue={s} maxLength={300} aria-label={`Step ${i + 1}`}
                onBlur={(e) => rename(i, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <button type="button" className="st-icobtn mv" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label={`Move step ${i + 1} up`}>↑</button>
              <button type="button" className="st-icobtn mv" onClick={() => move(i, 1)} disabled={i === items.length - 1} title="Move down" aria-label={`Move step ${i + 1} down`}>↓</button>
              <button type="button" className="st-icobtn" onClick={() => save(items.filter((_, k) => k !== i), `${format.name}: step removed.`)} title="Remove" aria-label={`Remove step ${i + 1}`}>{SI.trash}</button>
            </li>
          ))}
        </ol>
      )}
      {items.length < CHECK_MAX ? (
        <div className="st-check-add">
          <input className="st-in grow" value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)}
            placeholder={items.length ? "Add a step…" : `The first step for every ${format.name} task…`} aria-label={`New step for ${format.name}`}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
          <button type="button" className="st-btn" disabled={!draft.trim()} onClick={add}>{SI.plus}Add</button>
        </div>
      ) : <small className="st-note">A checklist has up to {CHECK_MAX} steps.</small>}
    </div>
  );
}
