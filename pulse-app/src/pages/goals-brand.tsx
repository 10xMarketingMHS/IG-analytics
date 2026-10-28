import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { gradFor } from "@/lib/editor-visuals";
import { monthName } from "@/lib/goal-periods";

// Goals › Brand goals — for admins and the edit_goals grant, laid out like Set
// goals (server/src/routes/brand-goals.js). The brands and the Ads teams down
// the left with how far along this month is; on the right, the one picked: how
// many jobs of each task type it needs, what's been done for it, and — across
// all of them — how much of each type the team's goals give out (Set goals shows
// the same as people's jobs are typed in). Brand goals don't change anyone's score.

type Cat = "social" | "ad" | "service" | "project";
type TypeRow = { id: string; name: string; icon: string | null; category: Cat };
type Place = { id: string; name: string; leadName?: string };
type Cell = { contentFormatId: string; channelId: string | null; adTeamId: string | null; jobs: number };
type Done = { contentFormatId: string; channelId: string | null; adTeamId: string | null; n: number };
type Resp = {
  ready: boolean; error?: string; month: string; prevMonth?: string;
  types: TypeRow[]; brands: Place[]; teams: Place[];
  goals: Cell[]; done: Done[]; given: Record<string, number>;
};
type Spot = { key: string; id: string; name: string; team: boolean; sub: string };

const CAT: Record<Cat, string> = { social: "Social", ad: "Ads", service: "Service", project: "Project" };
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const keyOf = (cf: string, place: string) => `${cf}:${place}`;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sv = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  check: sv(<path d="M20 6 9 17l-5-5" />),
  copy: sv(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, 15),
  lock: sv(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 14),
  gear: sv(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>, 15),
  ok: sv(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-5" /></>, 15),
  info: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>, 15),
  err: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>, 15),
};

// The team's goals against what the brands need: still to give, all given, or over.
export function giveWords(need: number, given: number): { cls: string; text: string } {
  const left = need - given;
  return left > 0 ? { cls: "warn", text: `${given} given · ${left} to give` }
    : left === 0 ? { cls: "good", text: `${given} given · all given` }
    : { cls: "over", text: `${given} given · ${-left} over` };
}

export function BrandGoals() {
  const months = useMemo(() => {
    const d = new Date();
    return [-1, 0, 1].map((k) => ymOf(new Date(d.getFullYear(), d.getMonth() + k, 1)));
  }, []);
  const thisMonth = months[1];
  const [month, setMonthRaw] = useState(thisMonth);
  const [data, setData] = useState<Resp | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selKey, setSelKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setDrafts({});
    setLoadError(false);
    api<Resp>(`/brand-goals?month=${month}-01`)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [month, reload]);

  const saved = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of data?.goals ?? []) m.set(keyOf(g.contentFormatId, g.adTeamId ?? g.channelId ?? ""), g.jobs);
    return m;
  }, [data]);
  const doneOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data?.done ?? []) m.set(keyOf(d.contentFormatId, d.adTeamId ?? d.channelId ?? ""), d.n);
    return m;
  }, [data]);
  const savedText = (k: string) => (saved.has(k) ? String(saved.get(k)) : "");
  const text = (k: string) => drafts[k] ?? savedText(k);
  const dirtyKeys = Object.keys(drafts).filter((k) => drafts[k].trim() !== savedText(k));

  function setMonth(m: string) {
    if (m === month) return;
    if (dirtyKeys.length && !window.confirm("You have brand goals that aren't saved. Leave them?")) return;
    setMonthRaw(m);
  }

  if (loadError) {
    return (
      <div className="gl-card gl-empty">
        Couldn't load the brand goals. Check your connection and try again.{" "}
        <button type="button" className="gl-btn" onClick={() => setReload((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  if (!data) return <div className="gl-card gl-empty">Loading brand goals…</div>;
  if (!data.ready) return <div className="gl-card gl-empty">{data.error}</div>;

  const spots: Spot[] = [
    ...data.brands.map((b) => ({ key: `b:${b.id}`, id: b.id, name: b.name, team: false, sub: "Brand" })),
    ...data.teams.map((t) => ({ key: `t:${t.id}`, id: t.id, name: t.name, team: true, sub: t.leadName ? `Ads team · ${t.leadName}` : "Ads team" })),
  ];
  if (!spots.length) return <div className="gl-card gl-empty">No brands or Ads teams yet — add brands in Settings › Channels.</div>;
  const typesFor = (s: Spot) => data.types.filter((t) => (t.category === "ad") === s.team);
  // how far along the month is: all of it for a month gone, none for one to come
  const now = new Date();
  const elapsed = month < thisMonth ? 1 : month > thisMonth ? 0
    : now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const calc = (s: Spot) => {
    const rows = typesFor(s).map((t) => {
      const k = keyOf(t.id, s.id);
      return { t, k, jobs: Number(text(k) || 0), done: doneOf.get(k) ?? 0 };
    });
    const need = rows.reduce((n, r) => n + r.jobs, 0);
    const toward = rows.reduce((n, r) => n + Math.min(r.done, r.jobs), 0);
    const pct = need ? toward / need : 0;
    const band = !need ? { cls: "", icon: IC.info, l: `No goals for ${s.name} yet — type the jobs it needs` }
      : toward >= need ? { cls: "good", icon: IC.ok, l: "Goal met" }
      : elapsed === 0 ? { cls: "", icon: IC.info, l: `Starts in ${monthName(month)}` }
      : elapsed === 1 ? { cls: "bad", icon: IC.err, l: `Short by ${need - toward} job${need - toward === 1 ? "" : "s"}` }
      : pct >= elapsed - 0.05 ? { cls: "good", icon: IC.ok, l: "On pace for the month" }
      : { cls: "warn", icon: IC.info, l: `Behind pace by ${Math.max(1, Math.ceil(need * elapsed - toward))} job${Math.ceil(need * elapsed - toward) > 1 ? "s" : ""}` };
    // toward: what's done of the types it has goals for, never more than each goal
    return { rows, need, toward, pct, band };
  };
  const sel = spots.find((s) => s.key === selKey) ?? spots[0];
  const c = calc(sel);
  const selDirty = dirtyKeys.filter((k) => k.endsWith(`:${sel.id}`));
  const others = (s: Spot) => spots.filter((x) => x.team === s.team);
  const allNeed = (t: TypeRow, s: Spot) => others(s).reduce((n, x) => n + Number(text(keyOf(t.id, x.id)) || 0), 0);

  async function save() {
    if (!selDirty.length || busy) return;
    const bad = selDirty.find((k) => { const v = drafts[k].trim(); return v && (!Number.isInteger(Number(v)) || Number(v) < 0); });
    if (bad) { toast.error("Each brand goal is a whole number of jobs."); return; }
    const goals = selDirty.map((k) => {
      const v = drafts[k].trim();
      return { contentFormatId: k.split(":")[0], ...(sel.team ? { adTeamId: sel.id } : { channelId: sel.id }), jobs: v ? Number(v) : null };
    });
    setBusy(true);
    try {
      await api("/brand-goals", { method: "PUT", body: JSON.stringify({ month: `${month}-01`, goals }) });
      const fresh = await api<Resp>(`/brand-goals?month=${month}-01`);
      setData(fresh);
      setDrafts((d) => { const n = { ...d }; for (const k of selDirty) delete n[k]; return n; });
      toast.success(`Goals saved for ${sel.name} · ${monthName(month)}.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the brand goals.");
    } finally {
      setBusy(false);
    }
  }
  const discard = () => setDrafts((d) => { const n = { ...d }; for (const k of selDirty) delete n[k]; return n; });
  async function copyLast() {
    if (!data?.prevMonth || busy) return;
    if (dirtyKeys.length) { toast.error("Save or discard your changes first."); return; }
    setBusy(true);
    try {
      const r = await api<{ copied: number }>("/brand-goals/copy", { method: "POST", body: JSON.stringify({ month: `${month}-01` }) });
      const from = monthName(data.prevMonth.slice(0, 7));
      toast.success(r.copied ? `Copied ${r.copied} brand goal${r.copied === 1 ? "" : "s"} from ${from}.` : `Nothing new to copy from ${from}.`);
      setReload((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't copy them.");
    } finally {
      setBusy(false);
    }
  }

  const listGroup = (team: boolean) => spots.filter((s) => s.team === team).map((s) => {
    const pc = calc(s);
    const on = s.key === sel.key;
    const unsaved = dirtyKeys.some((k) => k.endsWith(`:${s.id}`));
    return (
      <button key={s.key} type="button" className={"gs-person" + (on ? " on" : "")} aria-pressed={on} onClick={() => setSelKey(s.key)}>
        <span className="gl-ava sm gb-ava" style={{ background: gradFor(s.name) }}>{initials(s.name)}</span>
        <span>
          <b>{s.name}</b>
          <small>{unsaved ? "Unsaved · " : ""}{pc.need ? `${pc.need} job${pc.need === 1 ? "" : "s"} · ${pc.toward} done` : "No goals yet"}</small>
        </span>
        {pc.need > 0 && <em className={"gs-u " + pc.band.cls}>{elapsed === 0 ? pc.need : `${Math.floor(pc.pct * 100)}%`}</em>}
      </button>
    );
  });
  const setJobs = (k: string, v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  const filled = c.rows.filter((r) => r.jobs > 0);

  return (
    <div className="gl-stack">
      <div className="gl-bar">
        <div className="gl-seg gs-months" role="group" aria-label="Month">
          {months.map((m) => <button key={m} type="button" className={month === m ? "on" : ""} aria-pressed={month === m} onClick={() => setMonth(m)}><span className="gs-ml">{monthName(m)}</span><span className="gs-ms">{monthName(m, "short")}</span></button>)}
        </div>
        <span className="gl-grow" />
        {data.prevMonth && (
          <button type="button" className="gl-btn" disabled={busy} onClick={copyLast} title="Fills in only the brand goals this month doesn't have yet">
            {IC.copy}Copy {monthName(data.prevMonth.slice(0, 7))}
          </button>
        )}
        <span className="gs-who">{IC.lock}Admins and goal editors · editable any time</span>
      </div>

      <div className="gs-wrap">
        <section className="gl-card gs-list" aria-label="Brands and Ads teams">
          <div className="gs-listhead"><b>Brands</b><span>% done</span></div>
          <div className="gs-people">{data.brands.length ? listGroup(false) : <small className="gb-none">No brands yet</small>}</div>
          <div className="gs-listhead gb-listsub"><b>Ads teams</b></div>
          <div className="gs-people">{data.teams.length ? listGroup(true) : <small className="gb-none">No Ads teams yet</small>}</div>
        </section>

        <div className="gs-main">
          <section className="gl-card">
            <div className="gs-phead">
              <span className="gl-ava md gb-ava" style={{ background: gradFor(sel.name) }}>{initials(sel.name)}</span>
              <span>
                <b>{sel.name}</b>
                <small>{sel.sub} · {monthName(month)} goals</small>
              </span>
              <Link to={sel.team ? "/settings?s=tasks" : "/settings?s=channels"} className="gs-cal">{IC.gear}{sel.team ? "Ads teams" : "Brands"}</Link>
            </div>
            <div className="gs-tiles">
              <div><b>{c.need}</b><span>jobs needed</span></div>
              <div><b>{elapsed === 0 ? "—" : c.toward}</b><span>done toward it</span></div>
              <div className="ac"><b>{Math.max(0, c.need - c.toward)}</b><span>to go</span></div>
            </div>
            <div className="gs-capline">
              <span className="gs-formula">
                {filled.length ? `${filled.map((r) => `${r.jobs} ${r.t.name}`).join(" + ")} = ${c.need} job${c.need === 1 ? "" : "s"}` : "No jobs set yet"}
                <small>{sel.team ? "Ads made for this team" : "Social, Service and Project work for this brand"} · done counts what's completed in {monthName(month)}</small>
              </span>
            </div>
          </section>

          <section className="gl-card">
            <div className="gs-tscroll">
              <div className="gs-table">
                <div className="gs-row gb-r gs-th"><span>Task type</span><span className="c">Jobs</span><span className="c">Done</span><span className="r">{sel.team ? "All teams" : "All brands"} · team goals</span></div>
                {c.rows.length === 0 ? (
                  <div className="gl-empty">No {sel.team ? "Ads" : "Social, Service or Project"} types are tracked in goals yet — add them in Settings · Tasks & time.</div>
                ) : c.rows.map((r) => {
                  const all = allNeed(r.t, sel);
                  const g = all > 0 ? giveWords(all, data.given[r.t.id] ?? 0) : null;
                  return (
                    <div className={"gs-row gb-r" + (r.jobs ? "" : " none")} key={r.t.id}>
                      <span className="gs-type"><b>{r.t.icon} {r.t.name}</b><small>{CAT[r.t.category]}</small></span>
                      <input type="number" min={0} step={1} placeholder="—" aria-label={`${r.t.name} jobs for ${sel.name}`}
                        value={text(r.k)} onChange={(e) => setJobs(r.k, e.target.value)} />
                      <b className={"c gb-done" + (r.jobs > 0 && r.done >= r.jobs ? " met" : "")}>
                        {elapsed === 0 ? "—" : r.jobs ? `${r.done} / ${r.jobs}` : r.done || "—"}
                      </b>
                      <span className="r">
                        {g ? <em className={"gs-need " + g.cls} title="Every brand's goal for this type, against what the team's goals give out (Set goals)">{all} needed · {g.text}</em>
                          : <em className="gs-need">—</em>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="gs-hint">
              Jobs is how many of each type {sel.name} needs in {monthName(month)}. Done counts that type's tasks completed for {sel.team ? "this Ads team" : "this brand"} this month.
              The last column adds up every {sel.team ? "team" : "brand"} and sets it against the team's goals: give out the rest in Set goals. Brand goals don't change anyone's score.
            </p>
          </section>

          <section className="gl-card gs-sum">
            <span className="gs-num"><b className="ac">{c.need}</b><span>Jobs needed</span></span>
            <span className="gs-num"><b>{elapsed === 0 ? "—" : c.toward}</b><span>Done</span></span>
            <span className="gs-num"><b>{Math.max(0, c.need - c.toward)}</b><span>To go</span></span>
            <span className={"gs-band " + c.band.cls}>
              <span>{c.band.icon}<span>{c.band.l}</span>{c.need > 0 && <em>{Math.floor(c.pct * 100)}%</em>}</span>
              <i><i style={{ width: `${Math.min(100, c.pct * 100)}%` }} />{elapsed > 0 && elapsed < 1 && <s aria-hidden="true" style={{ left: `${elapsed * 100}%` }} />}</i>
            </span>
            <span className="gs-acts">
              {selDirty.length > 0 && <button type="button" className="gl-btn" disabled={busy} onClick={discard}>Discard</button>}
              <button type="button" className="gl-btn pri" disabled={!selDirty.length || busy} onClick={save} title={!selDirty.length ? "No changes" : undefined}>
                {IC.check}{busy ? "Saving…" : `Save ${sel.name}'s goals`}
              </button>
            </span>
          </section>
        </div>
      </div>
    </div>
  );
}
