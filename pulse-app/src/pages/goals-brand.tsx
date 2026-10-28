import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { monthName } from "@/lib/goal-periods";

// Goals › Brand goals — for admins and the edit_goals grant, like Set goals
// (server/src/routes/brand-goals.js): how many jobs of each task type each
// brand needs this month (Doctor Farmer 30 Reels, My Health School 30 Reels),
// and Ads by Ads team. Beside each, what's been done there this month; at the
// end of each row the total, and how much of it the team's goals give out —
// Set goals shows the same as people's jobs are typed in. Brand goals don't
// change anyone's score.

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

const CAT: Record<Cat, string> = { social: "Social", ad: "Ads", service: "Service", project: "Project" };
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const keyOf = (cf: string, place: string) => `${cf}:${place}`;
const sv = (d: ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  check: sv(<path d="M20 6 9 17l-5-5" />, 16),
  copy: sv(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>),
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
  const text = (k: string) => drafts[k] ?? (saved.has(k) ? String(saved.get(k)) : "");
  const dirtyKeys = Object.keys(drafts).filter((k) => drafts[k].trim() !== (saved.has(k) ? String(saved.get(k)) : ""));

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

  const showDone = month <= thisMonth;
  const typesOf = (ad: boolean) => data.types.filter((t) => (t.category === "ad") === ad);
  const sections = [
    { k: "brand", title: "Social, Service & Projects", sub: "by brand", places: data.brands, types: typesOf(false),
      empty: data.brands.length ? "No Social, Service or Project types are tracked in goals yet — Settings › Tasks & time." : "No brands yet — add them under Settings › Channels." },
    { k: "team", title: "Ads", sub: "by Ads team", places: data.teams, types: typesOf(true),
      empty: data.teams.length ? "No Ads types are tracked in goals yet — Settings › Tasks & time." : "No Ads teams yet — add them under Settings › Tasks & time › Ads teams." },
  ];

  async function save() {
    if (!data || !dirtyKeys.length || busy) return;
    const bad = dirtyKeys.find((k) => { const v = drafts[k].trim(); return v && (!Number.isInteger(Number(v)) || Number(v) < 0); });
    if (bad) { toast.error("Each brand goal is a whole number of jobs."); return; }
    const adTypes = new Set(typesOf(true).map((t) => t.id));
    const goals = dirtyKeys.map((k) => {
      const [cf, place] = k.split(":");
      const v = drafts[k].trim();
      return { contentFormatId: cf, ...(adTypes.has(cf) ? { adTeamId: place } : { channelId: place }), jobs: v ? Number(v) : null };
    });
    setBusy(true);
    try {
      await api("/brand-goals", { method: "PUT", body: JSON.stringify({ month: `${month}-01`, goals }) });
      toast.success(`Brand goals saved for ${monthName(month)}.`);
      setReload((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the brand goals.");
    } finally {
      setBusy(false);
    }
  }
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
      </div>

      {sections.map((s) => {
        const cols = `minmax(150px,1.4fr) repeat(${Math.max(1, s.places.length)}, minmax(86px,1fr)) minmax(64px,.7fr) minmax(130px,1.3fr)`;
        return (
          <section key={s.k} className="gl-card gb-card" aria-label={`${s.title} ${s.sub}`}>
            <div className="gb-head"><b>{s.title}</b><span>{s.sub}</span></div>
            {!s.places.length || !s.types.length ? <div className="gl-empty">{s.empty}</div> : (
              <div className="gs-tscroll">
                <div className="gb-table" style={{ minWidth: 150 + s.places.length * 96 + 210 }}>
                  <div className="gb-row gb-th" style={{ gridTemplateColumns: cols }}>
                    <span>Task type</span>
                    {s.places.map((p) => <span key={p.id} className="c" title={p.leadName ? `${p.name} · ${p.leadName}` : p.name}>{p.name}</span>)}
                    <span className="c">Total</span>
                    <span className="r">Team goals</span>
                  </div>
                  {s.types.map((t) => {
                    const need = s.places.reduce((n, p) => n + Number(text(keyOf(t.id, p.id)) || 0), 0);
                    const done = s.places.reduce((n, p) => n + (doneOf.get(keyOf(t.id, p.id)) ?? 0), 0);
                    const given = data.given[t.id] ?? 0;
                    const g = need > 0 ? giveWords(need, given) : null;
                    return (
                      <div key={t.id} className={"gb-row" + (need ? "" : " none")} style={{ gridTemplateColumns: cols }}>
                        <span className="gs-type"><b>{t.icon} {t.name}</b><small>{CAT[t.category]}</small></span>
                        {s.places.map((p) => {
                          const k = keyOf(t.id, p.id);
                          const want = Number(text(k) || 0), got = doneOf.get(k) ?? 0;
                          return (
                            <span key={p.id} className="gb-cell">
                              <input type="number" min={0} step={1} placeholder="—" aria-label={`${t.name} for ${p.name}`}
                                value={text(k)} onChange={(e) => setDrafts((d) => ({ ...d, [k]: e.target.value }))} />
                              {showDone && (want > 0 || got > 0) && (
                                <small className={want > 0 && got >= want ? "met" : ""}>{got}{want > 0 ? ` of ${want}` : ""} done</small>
                              )}
                            </span>
                          );
                        })}
                        <span className="c gb-total"><b>{need || "—"}</b>{showDone && need > 0 && <small>{done} done</small>}</span>
                        <span className="r gb-given">
                          {g ? <em className={g.cls}>{g.text}</em> : given > 0 ? <em>{given} given</em> : <em className="none">—</em>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}

      <section className="gl-card gs-sum gb-sum">
        <span className="gb-say">
          What each brand needs this month, by task type. <b>Team goals</b> is how many of each type the team's goals give out
          (Set goals); give out the rest there. Brand goals don't change anyone's score.
        </span>
        <span className="gs-acts">
          {dirtyKeys.length > 0 && <button type="button" className="gl-btn" disabled={busy} onClick={() => setDrafts({})}>Discard</button>}
          <button type="button" className="gl-btn pri" disabled={!dirtyKeys.length || busy} onClick={save}>
            {IC.check}{busy ? "Saving…" : "Save brand goals"}
          </button>
        </span>
      </section>
    </div>
  );
}
