import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { gradFor } from "@/lib/editor-visuals";
import { monthName } from "@/lib/goal-periods";
import { useContentFormats } from "@/lib/use-content-formats";
import { groupTypes, kindsWord, useFolds } from "@/lib/type-groups";

// Goals › Brand goals — for admins and the edit_goals grant, laid out like Set
// goals (server/src/routes/brand-goals.js). Total counts first — every task
// type across all brands and Ads teams, against what Set goals gives out to the
// editors — then the brands and the Ads teams down the left with how far along
// this month is; on the right, the one picked: how
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
  // a main type's sub-types fold under its row (Settings › Tasks & time)
  const { contentFormats } = useContentFormats();
  const folds = useFolds();

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
  // Total counts: each type across every brand (Ads: every Ads team), against what Set goals gives out
  const totalOn = (selKey ?? "total") === "total";
  const totals = data.types.map((t) => {
    const places = spots.filter((x) => x.team === (t.category === "ad"));
    const need = places.reduce((n, x) => n + Number(text(keyOf(t.id, x.id)) || 0), 0);
    const done = places.reduce((n, x) => n + (doneOf.get(keyOf(t.id, x.id)) ?? 0), 0);
    return { t, need, done, given: data.given[t.id] ?? 0 };
  });
  const tNeed = totals.reduce((n, r) => n + r.need, 0);
  // given toward the brand goals (never more than each needs); what goes to types with no brand goal, apart
  const tGiven = totals.reduce((n, r) => n + Math.min(r.given, r.need), 0);
  const tExtra = totals.reduce((n, r) => n + (r.need ? 0 : r.given), 0);
  const tToGive = totals.reduce((n, r) => n + Math.max(0, r.need - r.given), 0);
  const tOver = totals.reduce((n, r) => n + (r.need > 0 ? Math.max(0, r.given - r.need) : 0), 0);
  const tPct = tNeed ? tGiven / tNeed : 0;
  const tBand = !tNeed ? { cls: "", icon: IC.info, l: `No brand goals for ${monthName(month)} yet` }
    : tToGive === 0 && tOver === 0 ? { cls: "good", icon: IC.ok, l: "Team goals match the brand goals" }
    : tToGive === 0 ? { cls: "good", icon: IC.ok, l: `All given · ${tOver} more than the brands need` }
    : { cls: "warn", icon: IC.info, l: `${tToGive} job${tToGive === 1 ? "" : "s"} still to give out in Set goals` };
  // rows by main type, each with its sub-types after it, the sub-types showing only when it's open
  const parentOf = (id: string) => contentFormats?.find((f) => f.id === id)?.parent_id;
  function folded<R extends { t: TypeRow }>(rs: R[]) {
    return groupTypes(rs, (r) => r.t.id, parentOf).flatMap((g) => [g.main, ...(folds.isOpen(g.main.t.id) ? g.subs : [])]
      .map((r) => ({ r, sub: r !== g.main, subs: r === g.main ? g.subs : [], open: folds.isOpen(g.main.t.id) })));
  }
  const foldBtn = (t: TypeRow, n: number, open: boolean, sum: string) => (
    <button type="button" className="gs-fold" aria-expanded={open} onClick={() => folds.toggle(t.id)} title={open ? "Hide its sub-types" : "Show its sub-types — each has its own count"}>
      {kindsWord(n)}{sum ? ` · ${sum}` : ""} {open ? "▴" : "▾"}
    </button>
  );
  const matchOf = (r: { need: number; given: number }) => (!r.need && !r.given ? { cls: "", text: "—" }
    : !r.need ? { cls: "", text: `No brand goal · ${r.given} given` }
    : r.given === r.need ? { cls: "good", text: "✓ Matches" }
    : r.given < r.need ? { cls: "warn", text: `${r.need - r.given} to give` }
    : { cls: "over", text: `${r.given - r.need} over` });
  const sel = spots.find((s) => s.key === selKey) ?? spots[0];
  const c = calc(sel);
  const selDirty = dirtyKeys.filter((k) => k.endsWith(`:${sel.id}`));
  const others = (s: Spot) => spots.filter((x) => x.team === s.team);
  const allNeed = (t: TypeRow, s: Spot) => others(s).reduce((n, x) => n + Number(text(keyOf(t.id, x.id)) || 0), 0);

  async function save() {
    if (totalOn || !selDirty.length || busy) return;
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
    const on = !totalOn && s.key === sel.key;
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
          <div className="gs-listhead"><b>Total counts</b><span>% given</span></div>
          <div className="gs-people">
            <button type="button" className={"gs-person" + (totalOn ? " on" : "")} aria-pressed={totalOn} onClick={() => setSelKey("total")}>
              <span className="gl-ava sm gb-ava gb-sigma">Σ</span>
              <span>
                <b>All brands &amp; teams</b>
                <small>{tNeed ? `${tNeed} needed · ${tGiven} given` : "No brand goals yet"}</small>
              </span>
              {tNeed > 0 && <em className={"gs-u " + (tToGive === 0 ? "good" : "warn")}>{Math.floor(tPct * 100)}%</em>}
            </button>
          </div>
          <div className="gs-listhead gb-listsub"><b>Brands</b><span>% done</span></div>
          <div className="gs-people">{data.brands.length ? listGroup(false) : <small className="gb-none">No brands yet</small>}</div>
          <div className="gs-listhead gb-listsub"><b>Ads teams</b></div>
          <div className="gs-people">{data.teams.length ? listGroup(true) : <small className="gb-none">No Ads teams yet</small>}</div>
        </section>

        {totalOn ? (
        <div className="gs-main">
          <section className="gl-card">
            <div className="gs-phead">
              <span className="gl-ava md gb-ava gb-sigma">Σ</span>
              <span>
                <b>Total counts</b>
                <small>All brands and Ads teams · {monthName(month)} goals</small>
              </span>
              <Link to="/goals-board?tab=set" className="gs-cal">{IC.gear}Set goals</Link>
            </div>
            <div className="gs-tiles">
              <div><b>{tNeed}</b><span>jobs needed</span></div>
              <div><b>{tGiven}</b><span>given to editors toward them</span></div>
              <div className="ac"><b>{tToGive}</b><span>still to give</span></div>
            </div>
            <div className="gs-capline">
              <span className="gs-formula">
                {tNeed ? `Brands ${totals.filter((r) => r.t.category !== "ad").reduce((n, r) => n + r.need, 0)} + Ads teams ${totals.filter((r) => r.t.category === "ad").reduce((n, r) => n + r.need, 0)} = ${tNeed} jobs` : "No brand goals set yet"}
                <small>Given to editors comes from Set goals{tExtra ? ` · ${tExtra} more given for types with no brand goal` : ""} · done counts what's completed in {monthName(month)}</small>
              </span>
            </div>
          </section>

          <section className="gl-card">
            <div className="gs-tscroll">
              <div className="gs-table">
                <div className="gs-row gb-t gs-th"><span>Task type</span><span className="c">Brands need</span><span className="c">Given</span><span className="c">Done</span><span className="r">Match</span></div>
                {([["Social, Service & Projects", false], ["Ads", true]] as const).map(([label, ad]) => {
                  const rs = totals.filter((r) => (r.t.category === "ad") === ad);
                  if (!rs.length) return null;
                  return (
                    <Fragment key={label}>
                      <div className="gb-grp">{label}<small>{ad ? "every Ads team" : "every brand"}</small></div>
                      {folded(rs).map(({ r, sub, subs, open }) => {
                        const mt = matchOf(r);
                        const subNeed = subs.reduce((n, s) => n + s.need, 0), subGiven = subs.reduce((n, s) => n + s.given, 0);
                        return (
                          <div className={"gs-row gb-t" + (r.need || r.given || subNeed || subGiven ? "" : " none") + (sub ? " sub" : "")} key={r.t.id}>
                            <span className="gs-typecell">
                              <span className="gs-type"><b>{r.t.icon} {r.t.name}</b><small>{CAT[r.t.category]}</small></span>
                              {subs.length > 0 && foldBtn(r.t, subs.length, open, subNeed || subGiven ? `${subNeed} needed · ${subGiven} given` : "")}
                            </span>
                            <b className="c gb-done">{r.need || "—"}</b>
                            <b className="c gb-done">{r.given || "—"}</b>
                            <b className={"c gb-done" + (r.need > 0 && r.done >= r.need ? " met" : "")}>{elapsed === 0 ? "—" : r.done || "—"}</b>
                            <span className="r"><em className={"gs-need " + mt.cls}>{mt.text}</em></span>
                          </div>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </div>
            </div>
            <p className="gs-hint">
              Brands need adds up every brand's goal for the type (Ads: every Ads team's). Given is what the editors' goals in Set goals add up to.
              When they match, everything the brands need has someone on it. Done counts the type's tasks completed this month.
            </p>
          </section>

          <section className="gl-card gs-sum">
            <span className="gs-num"><b className="ac">{tNeed}</b><span>Jobs needed</span></span>
            <span className="gs-num"><b>{tGiven}</b><span>Given</span></span>
            <span className="gs-num"><b>{tToGive}</b><span>To give</span></span>
            <span className={"gs-band " + tBand.cls}>
              <span>{tBand.icon}<span>{tBand.l}</span>{tNeed > 0 && <em>{Math.floor(tPct * 100)}%</em>}</span>
              <i><i style={{ width: `${Math.min(100, tPct * 100)}%` }} /></i>
            </span>
            <span className="gs-acts">
              <Link to="/goals-board?tab=set" className="gl-btn pri">{IC.check}Give out in Set goals</Link>
            </span>
          </section>
        </div>
        ) : (
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
                ) : folded(c.rows).map(({ r, sub, subs, open }) => {
                  const all = allNeed(r.t, sel);
                  const g = all > 0 ? giveWords(all, data.given[r.t.id] ?? 0) : null;
                  const subJobs = subs.reduce((n, s) => n + s.jobs, 0);
                  return (
                    <div className={"gs-row gb-r" + (r.jobs || subJobs ? "" : " none") + (sub ? " sub" : "")} key={r.t.id}>
                      <span className="gs-typecell">
                        <span className="gs-type"><b>{r.t.icon} {r.t.name}</b><small>{CAT[r.t.category]}</small></span>
                        {subs.length > 0 && foldBtn(r.t, subs.length, open, subJobs ? `${subJobs} job${subJobs === 1 ? "" : "s"}` : "")}
                      </span>
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
        )}
      </div>
    </div>
  );
}
