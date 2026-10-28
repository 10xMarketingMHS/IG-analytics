import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useEditors } from "@/lib/use-editors";
import { gradFor } from "@/lib/editor-visuals";
import { goalPointsTotal } from "@/lib/goal-points";
import { monthName } from "@/lib/goal-periods";
import { fmtHours } from "@/pages/settings-ui";
import { giveWords } from "@/pages/goals-brand";
import type { Editor } from "@/lib/types";

// Goals › Set goals (Pulse Redesign v5) — for admins and the edit_goals grant:
// each editor's monthly goals, one job count per task type, checked against the
// hours they have that month. Only the job counts are set here. Hours per job
// is each type's time from Settings › Tasks & time, and working days and hours
// come from the work calendar in Settings › General — shown here as numbers,
// changed there. The list on the left shows how much of everyone's time is
// planned; the bar at the bottom has the totals and Save, which stays off while
// the plan is more than they have time for.

// durationDays: a project's days, each one a full work day of hours (server/src/routes/goals.js)
type Row = { contentFormatId: string; name: string; icon: string; category: string | null; jc: number | null; jph: number; points: number; budget?: number | null; durationDays?: number | null };
type Cap = { workingDays: number; hoursPerDay: number };
type GoalsResp = {
  month: string;
  capacity: Cap & { hours: number; source: string };
  orgDefault: Cap | null;
  editorOverride: Cap | null;
  rows: Row[];
};
// Job counts typed but not saved, per person.
type Draft = Record<string, string>;

const CAT: Record<string, string> = { social: "Social", ad: "Ads", service: "Service", project: "Project" };
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sv = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  cal: sv(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>, 15),
  lock: sv(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 14),
  check: sv(<path d="M20 6 9 17l-5-5" />),
  ok: sv(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-5" /></>, 15),
  err: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>, 15),
  info: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>, 15),
};

const draftOf = (d: GoalsResp): Draft => Object.fromEntries(d.rows.map((r) => [r.contentFormatId, r.jc == null ? "" : String(r.jc)]));
// Hours per job: the type's current time (Settings › Tasks & time); a type
// with no time keeps what the goal was saved with.
const jphOf = (r: Row) => r.budget ?? r.jph;
const capOf = (d: GoalsResp): Cap => d.editorOverride ?? { workingDays: d.capacity.workingDays, hoursPerDay: d.capacity.hoursPerDay };
function calc(d: GoalsResp, dr: Draft) {
  const cap = capOf(d);
  const capH = cap.workingDays * cap.hoursPerDay;
  const rows = d.rows.map((r) => {
    const jobs = Number(dr[r.contentFormatId] || 0), jph = jphOf(r);
    return { r, jobs, jph, hrs: jobs * jph };
  });
  const plan = rows.reduce((s, x) => s + x.hrs, 0);
  return { cap, capH, rows, plan, over: plan > capH + 1e-9, util: capH > 0 ? plan / capH : plan > 0 ? 1.5 : 0 };
}
const bandOf = (c: ReturnType<typeof calc>) =>
  c.over ? { cls: "bad", icon: IC.err, l: `Over capacity by ${fmtHours(c.plan - c.capH)} — remove some jobs to save` }
    : c.util >= 0.85 ? { cls: "good", icon: IC.ok, l: "Good fit" }
    : { cls: "warn", icon: IC.info, l: `Room for ${fmtHours(c.capH - c.plan)} more` };
const isDirty = (d: GoalsResp, dr: Draft) => JSON.stringify(dr) !== JSON.stringify(draftOf(d));

function Face({ editor, size = "md" }: { editor: Pick<Editor, "name" | "image_url">; size?: "sm" | "md" }) {
  return editor.image_url
    ? <img className={"gl-ava " + size} src={editor.image_url} alt="" />
    : <span className={"gl-ava " + size} style={{ background: gradFor(editor.name) }}>{initials(editor.name)}</span>;
}

export function SetGoals() {
  const { editors } = useEditors();
  const months = useMemo(() => {
    const d = new Date();
    return [-1, 0, 1].map((k) => ymOf(new Date(d.getFullYear(), d.getMonth() + k, 1)));
  }, []);
  const [month, setMonthRaw] = useState(months[1]);
  const people = useMemo(() => (editors ?? []).filter((e) => e.active), [editors]);
  const ids = people.map((e) => e.id).join(",");
  const [data, setData] = useState<Record<string, GoalsResp> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selId, setSelId] = useState<string | null>(null);
  // what the brands need of each type this month (Goals › Brand goals)
  const [need, setNeed] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  // Everyone's goals and capacity for the month, in one request.
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (editors === null) return;
    if (!ids) { setData({}); return; }
    let live = true;
    setData(null);
    setDrafts({});
    setLoadError(false);
    const want = new Set(ids.split(","));
    api<{ people: Record<string, GoalsResp>; brandNeed?: Record<string, number> }>(`/goals/set-all?month=${month}-01`)
      .then((d) => {
        if (!live) return;
        setData(Object.fromEntries(Object.entries(d.people).filter(([id]) => want.has(id))));
        setNeed(d.brandNeed ?? {});
      })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [editors, ids, month, reload]);

  const unsaved = Object.keys(drafts).filter((id) => data?.[id] && isDirty(data[id], drafts[id]));
  function setMonth(m: string) {
    if (m === month) return;
    if (unsaved.length && !window.confirm(`You have goals that aren't saved for ${unsaved.length === 1 ? "1 person" : `${unsaved.length} people`}. Leave them?`)) return;
    setMonthRaw(m);
  }

  // The team's days and hours — every editor's capacity unless they have their own.
  const team = useMemo((): Cap => {
    const all = Object.values(data ?? {});
    const org = all.find((d) => d.orgDefault)?.orgDefault;
    if (org) return org;
    const plain = all.find((d) => d.capacity.source !== "editor");
    return plain ? { workingDays: plain.capacity.workingDays, hoursPerDay: plain.capacity.hoursPerDay } : { workingDays: 22, hoursPerDay: 8 };
  }, [data]);

  if (loadError) {
    return (
      <div className="gl-card gl-empty">
        Couldn't load the goals. Check your connection and try again.{" "}
        <button type="button" className="gl-btn" onClick={() => setReload((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  if (editors === null || data === null) return <div className="gl-card gl-empty">Loading goals…</div>;
  const loaded = people.filter((p) => data[p.id]);
  if (!loaded.length) return <div className="gl-card gl-empty">No team members to set goals for yet.</div>;

  const sel = loaded.find((p) => p.id === selId) ?? loaded[0];
  const sd = data[sel.id];
  const dr = drafts[sel.id] ?? draftOf(sd);
  const c = calc(sd, dr);
  const b = bandOf(c);
  const dirty = isDirty(sd, dr);
  const ownHours = c.cap.workingDays !== team.workingDays || c.cap.hoursPerDay !== team.hoursPerDay;
  const first = sel.name.split(" ")[0];
  const goalPoints = goalPointsTotal(c.rows.map((x) => ({ jc: x.jobs || null, points: x.r.points })));
  const balance = c.capH - c.plan;
  const setJobs = (id: string, v: string) => setDrafts((s) => ({ ...s, [sel.id]: { ...(s[sel.id] ?? draftOf(sd)), [id]: v } }));
  // how many of a type the whole team's goals give out, as typed (unsaved too)
  const givenOf = (cf: string) => loaded.reduce((n, p) => n + Number((drafts[p.id] ?? draftOf(data[p.id]))[cf] || 0), 0);

  async function save() {
    if (!dirty) return;
    if (c.over) { toast.error(`${first} is ${fmtHours(c.plan - c.capH)} over capacity — reduce the jobs first.`); return; }
    const bad = sd.rows.find((r) => {
      const v = dr[r.contentFormatId]?.trim();
      return v && (!Number.isInteger(Number(v)) || Number(v) < 0);
    });
    if (bad) { toast.error(`Jobs for ${bad.name} must be a whole number.`); return; }
    setSaving(true);
    try {
      const goals = sd.rows.map((r) => {
        const v = dr[r.contentFormatId]?.trim();
        return { contentFormatId: r.contentFormatId, jc: v ? Number(v) : null, jph: jphOf(r) };
      });
      await api("/goals", { method: "PUT", body: JSON.stringify({ editorId: sel.id, month: `${month}-01`, goals }) });
      const fresh = await api<GoalsResp>(`/goals?editorId=${sel.id}&month=${month}-01`);
      setData((s) => ({ ...(s ?? {}), [sel.id]: fresh }));
      setDrafts((s) => { const n = { ...s }; delete n[sel.id]; return n; });
      toast.success(`Goals saved for ${sel.name} · Team goals updated.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the goals.");
    } finally {
      setSaving(false);
    }
  }
  const discard = () => setDrafts((s) => { const n = { ...s }; delete n[sel.id]; return n; });

  return (
    <div className="gl-stack">
      <div className="gl-bar">
        <div className="gl-seg gs-months" role="group" aria-label="Month">
          {months.map((m) => <button key={m} type="button" className={month === m ? "on" : ""} aria-pressed={month === m} onClick={() => setMonth(m)}><span className="gs-ml">{monthName(m)}</span><span className="gs-ms">{monthName(m, "short")}</span></button>)}
        </div>
        <span className="gl-grow" />
        <span className="gs-who">{IC.lock}Admins and goal editors · editable any time</span>
      </div>

      <div className="gs-wrap">
        <section className="gl-card gs-list" aria-label="Editors">
          <div className="gs-listhead"><b>Editors</b><span>% planned</span></div>
          <div className="gs-people">
            {loaded.map((p) => {
              const pc = calc(data[p.id], drafts[p.id] ?? draftOf(data[p.id]));
              const pb = bandOf(pc);
              const on = p.id === sel.id;
              return (
                <button key={p.id} type="button" className={"gs-person" + (on ? " on" : "")} aria-pressed={on} onClick={() => setSelId(p.id)}>
                  <Face editor={p} size="sm" />
                  <span>
                    <b>{p.name}</b>
                    <small>{unsaved.includes(p.id) ? "Unsaved · " : ""}{fmtHours(pc.plan)} of {fmtHours(pc.capH)}</small>
                  </span>
                  <em className={"gs-u " + pb.cls}>{Math.floor(pc.util * 100)}%</em>
                </button>
              );
            })}
          </div>
        </section>

        <div className="gs-main">
          <section className="gl-card">
            <div className="gs-phead">
              <Face editor={sel} />
              <span>
                <b>{sel.name}</b>
                <small>{sel.designation || "Team member"} · {monthName(month)} capacity</small>
              </span>
              <Link to="/settings" className="gs-cal">{IC.cal}Work calendar</Link>
            </div>
            <div className="gs-tiles">
              <div><b>{c.cap.workingDays}</b><span>working days</span></div>
              <div><b>{fmtHours(c.cap.hoursPerDay)}</b><span>a day</span></div>
              <div className="ac"><b>{fmtHours(c.capH)}</b><span>capacity</span></div>
            </div>
            <div className="gs-capline">
              <span className="gs-formula">
                {c.cap.workingDays} working days × {fmtHours(c.cap.hoursPerDay)} = {fmtHours(c.capH)}
                <small>{ownHours
                  ? `${first} has their own hours · the team has ${team.workingDays} days × ${fmtHours(team.hoursPerDay)}`
                  : "From the team's work calendar — change it in Settings › General"}</small>
              </span>
            </div>
          </section>

          <section className="gl-card">
            <div className="gs-tscroll">
              <div className="gs-table">
                <div className="gs-row gs-th"><span>Task type</span><span className="c">Jobs</span><span className="c">Hrs / job</span><span className="r">Hours</span><span className="r">R1 · R2</span></div>
                {c.rows.length === 0 ? (
                  <div className="gl-empty">No task types yet — add them in Settings · Tasks & time.</div>
                ) : c.rows.map((x) => (
                  <div className={"gs-row" + (x.jobs ? "" : " none")} key={x.r.contentFormatId}>
                    <span className="gs-typecell">
                      <span className="gs-type"><b>{x.r.icon} {x.r.name}</b><small>{x.r.category ? CAT[x.r.category] ?? x.r.category : ""}</small></span>
                      {need[x.r.contentFormatId] > 0 && (() => {
                        const g = giveWords(need[x.r.contentFormatId], givenOf(x.r.contentFormatId));
                        return <small className={"gs-need " + g.cls} title="From Goals › Brand goals: what the brands need of it this month, and how much the team's goals give out">Brands need {need[x.r.contentFormatId]} · {g.text}</small>;
                      })()}
                    </span>
                    <input type="number" min={0} step={1} placeholder="—" aria-label={`Jobs of ${x.r.name}`}
                      value={dr[x.r.contentFormatId] ?? ""} onChange={(e) => setJobs(x.r.contentFormatId, e.target.value)} />
                    {x.r.durationDays ? (
                      <span className="c gs-jph" title={`A project's days count as full work days: ${x.r.durationDays} × ${fmtHours(c.cap.hoursPerDay)} = ${fmtHours(x.jph)}. Change the days in Settings › Tasks & time.`}>
                        {x.r.durationDays} day{x.r.durationDays === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span className="c gs-jph" title="The task type's time — change it in Settings › Tasks & time">{x.jph ? fmtHours(x.jph) : "—"}</span>
                    )}
                    <b className="r">{x.jobs ? fmtHours(x.hrs) : "—"}</b>
                    <span className="r gs-split">{x.jobs ? `${Math.ceil(x.jobs / 2)} · ${x.jobs - Math.ceil(x.jobs / 2)}` : "—"}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="gs-hint">
              Leave Jobs blank when there's no goal for that type. Hrs / job is each type's time from Settings › Tasks &amp; time. R1 · R2 splits
              the target across the two reviews. "Brands need" comes from Brand goals: how much of it is still to give out to the team.
            </p>
          </section>

          <section className="gl-card gs-sum">
            <span className="gs-num"><b className="ac">{Math.round(goalPoints * 10) / 10}</b><span>Goal points</span></span>
            <span className="gs-num"><b>{fmtHours(c.capH)}</b><span>Capacity</span></span>
            <span className="gs-num"><b className={c.over ? "bad" : ""}>{fmtHours(c.plan)}</b><span>Planned</span></span>
            <span className="gs-num"><b className={balance < 0 ? "bad" : ""}>{balance >= 0 ? "+" : ""}{fmtHours(balance)}</b><span>Balance</span></span>
            <span className={"gs-band " + b.cls}>
              <span>{b.icon}<span>{b.l}</span><em>{Math.floor(c.util * 100)}%</em></span>
              <i><i style={{ width: `${Math.min(100, c.util * 100)}%` }} /><s aria-hidden="true" /></i>
            </span>
            <span className="gs-acts">
              {dirty && <button type="button" className="gl-btn" onClick={discard}>Discard</button>}
              <button type="button" className="gl-btn pri" disabled={!dirty || c.over || saving} onClick={save}
                title={c.over ? "Planned hours are more than the capacity" : !dirty ? "No changes" : undefined}>
                {IC.check}{saving ? "Saving…" : `Save ${first}'s goals`}
              </button>
            </span>
          </section>
        </div>
      </div>
    </div>
  );
}
