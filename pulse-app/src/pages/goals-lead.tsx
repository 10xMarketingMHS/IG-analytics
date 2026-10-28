import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { gradFor } from "@/lib/editor-visuals";
import { monthName, tenths } from "@/lib/goal-periods";

// Goals › Lead goals (server/src/routes/lead-goals.js): each Team Lead's key
// results for the month — 200 L1 Conversions, 500 Leads, 50,000 Followers —
// that the team delivers and the lead answers for, looked at in the Tactical
// meetings: Review 1 (1–15) and Review 2 (16–month end). Counts are typed in at
// each meeting; Followers is read from the connected social accounts. Below,
// how each member's goals stand in a review, by Team goals' rule. Not part of
// anyone's task score. Whoever sets the goals sets these; a Team Lead sees his
// own and types in the numbers.

type Kind = "count" | "followers";
type Goal = { id: string; editorId: string; name: string; kind: Kind; target: number; r1Actual: number | null; r2Actual: number | null };
type Lead = { id: string; name: string; imageUrl: string | null; designation: string | null };
type Half = { target: number; done: number; pct: number | null; missed: number };
type Member = { editorId: string; name: string; imageUrl: string | null; designation: string | null; h1: Half; h2: Half };
type Followers = { accounts: number; now: number; start: number | null; r1: number; r2: number };
type Resp = {
  ready: boolean; error?: string; month: string; prevMonth?: string; canEdit: boolean; me: string | null;
  leads: Lead[]; goals: Goal[]; followers: Followers; team: Member[];
};
// a key result being edited: numbers as typed
type Row = { id: string | null; name: string; kind: Kind; target: string; r1: string; r2: string };

const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const n0 = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
const sv = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  check: sv(<path d="M20 6 9 17l-5-5" />),
  copy: sv(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, 15),
  lock: sv(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 14),
  plus: sv(<path d="M12 5v14M5 12h14" />, 15),
  x: sv(<path d="M18 6 6 18M6 6l12 12" />, 14),
};
const SUGGEST: [string, Kind][] = [["L1 Conversions", "count"], ["Leads", "count"], ["Followers", "followers"]];
const rowsOf = (goals: Goal[], leadId: string): Row[] => goals.filter((g) => g.editorId === leadId).map((g) => ({
  id: g.id, name: g.name, kind: g.kind, target: String(g.target), r1: g.r1Actual == null ? "" : String(g.r1Actual), r2: g.r2Actual == null ? "" : String(g.r2Actual),
}));
const num = (v: string) => (v.trim() === "" ? null : Number(v));
const badNum = (v: string) => v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0);
const bandOf = (x: number | null) => (x == null ? "" : x >= 0.8 ? "good" : x >= 0.5 ? "warn" : "bad");

export function LeadGoals() {
  const months = useMemo(() => {
    const d = new Date();
    return [-1, 0, 1].map((k) => ymOf(new Date(d.getFullYear(), d.getMonth() + k, 1)));
  }, []);
  const thisMonth = months[1];
  const [month, setMonthRaw] = useState(thisMonth);
  const [data, setData] = useState<Resp | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Row[]>>({});
  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Kind>("count");
  const [newTarget, setNewTarget] = useState("");
  const [half, setHalf] = useState<"h1" | "h2">(new Date().getDate() <= 15 ? "h1" : "h2");

  useEffect(() => {
    let live = true;
    setData(null);
    setDrafts({});
    setFailed(null);
    api<Resp>(`/lead-goals?month=${month}-01`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setFailed(e instanceof ApiError ? e.message : "Couldn't load the lead goals. Check your connection and try again."); });
    return () => { live = false; };
  }, [month, reload]);

  const dirtyLeads = data ? Object.keys(drafts).filter((id) => JSON.stringify(drafts[id]) !== JSON.stringify(rowsOf(data.goals, id))) : [];
  function setMonth(m: string) {
    if (m === month) return;
    if (dirtyLeads.length && !window.confirm("You have key results that aren't saved. Leave them?")) return;
    setMonthRaw(m);
  }

  if (failed) {
    return (
      <div className="gl-card gl-empty">
        {failed}{" "}<button type="button" className="gl-btn" onClick={() => setReload((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  if (!data) return <div className="gl-card gl-empty">Loading lead goals…</div>;
  if (!data.ready) return <div className="gl-card gl-empty">{data.error}</div>;
  if (!data.leads.length) return <div className="gl-card gl-empty">No Team Leads yet — give someone the Team Lead position on Team › Roster.</div>;

  const sel = data.leads.find((l) => l.id === selId) ?? data.leads[0];
  const saved = rowsOf(data.goals, sel.id);
  const rows = drafts[sel.id] ?? saved;
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const canEdit = data.canEdit;
  const first = sel.name.split(" ")[0];
  const f = data.followers;
  const setRows = (next: Row[]) => setDrafts((d) => ({ ...d, [sel.id]: next }));
  const patch = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  // how far along the month and each review are
  const today = new Date();
  const day = month === thisMonth ? today.getDate() : month < thisMonth ? 99 : 0;
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const r1Over = day > 15, r2Over = day > lastDay;
  const elapsed = month < thisMonth ? 1 : month > thisMonth ? 0 : today.getDate() / lastDay;

  // a key result's standing: each review against half its target (Review 1 the first half), and the month
  const standing = (r: Row) => {
    const target = Number(r.target) || 0;
    if (r.kind === "followers") {
      const pct = target ? f.now / target : null;
      return { r1t: null, r2t: null, month: f.now, pct, text: !target ? "—" : f.now >= target ? "Reached" : `${n0(target - f.now)} to go`, cls: target && f.now >= target ? "good" : "warn" };
    }
    const r1t = tenths(target / 2), r2t = tenths(target - r1t);
    const a1 = num(r.r1) ?? 0, a2 = num(r.r2) ?? 0, sum = a1 + a2;
    const pct = target ? sum / target : null;
    const text = !target ? "—" : sum >= target ? "Met"
      : elapsed === 0 ? "Not started" : elapsed === 1 ? `Short by ${n0(target - sum)}`
      : (pct ?? 0) >= elapsed - 0.05 ? "On pace" : `Behind by ${n0(Math.ceil(target * elapsed - sum))}`;
    const cls = !target ? "" : sum >= target ? "good" : elapsed === 1 ? "bad" : (pct ?? 0) >= elapsed - 0.05 ? "good" : "warn";
    return { r1t, r2t, month: sum, pct, text, cls };
  };
  const st = rows.map(standing);
  // the usual key results not added yet, one tap each
  const missing = SUGGEST.filter(([n, k]) => !rows.some((r) => r.name.trim().toLowerCase() === n.toLowerCase() || (k === "followers" && r.kind === "followers")));
  const onTrack = st.filter((s) => s.cls === "good").length;

  async function save() {
    if (!dirty || busy) return;
    if (rows.some((r) => !r.name.trim())) { toast.error("Each key result needs a name."); return; }
    if (rows.some((r) => r.target.trim() === "" || badNum(r.target) || badNum(r.r1) || badNum(r.r2))) { toast.error("Targets and numbers are whole or decimal numbers, 0 or more."); return; }
    setBusy(true);
    try {
      await api("/lead-goals", { method: "PUT", body: JSON.stringify({
        month: `${month}-01`, editorId: sel.id,
        goals: rows.map((r) => ({ id: r.id, name: r.name.trim(), kind: r.kind, target: Number(r.target), r1Actual: num(r.r1), r2Actual: num(r.r2) })),
      }) });
      const fresh = await api<Resp>(`/lead-goals?month=${month}-01`);
      setData(fresh);
      setDrafts((d) => { const n = { ...d }; delete n[sel.id]; return n; });
      toast.success(`Key results saved for ${sel.name} · ${monthName(month)}.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the key results.");
    } finally {
      setBusy(false);
    }
  }
  async function copyLast() {
    if (!data?.prevMonth || busy) return;
    setBusy(true);
    try {
      const r = await api<{ copied: number }>("/lead-goals/copy", { method: "POST", body: JSON.stringify({ month: `${month}-01`, editorId: sel.id }) });
      toast.success(r.copied ? `Copied ${r.copied} key result${r.copied === 1 ? "" : "s"} from ${monthName(data.prevMonth.slice(0, 7))}.` : `${first} had none in ${monthName(data.prevMonth.slice(0, 7))}.`);
      setReload((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't copy them.");
    } finally {
      setBusy(false);
    }
  }
  function add(name = newName, kind = newKind, target = newTarget) {
    if (!name.trim()) return;
    if (kind === "followers" && rows.some((r) => r.kind === "followers")) { toast.error("Followers is already a key result."); return; }
    setRows([...rows, { id: null, name: name.trim(), kind, target: target.trim(), r1: "", r2: "" }]);
    setNewName(""); setNewTarget(""); setNewKind("count");
  }

  const team = data.team;
  const teamSorted = [...team].sort((a, b) => (a[half].pct ?? 2) - (b[half].pct ?? 2) || a.name.localeCompare(b.name));
  const halfLabel = (h: "h1" | "h2") => (h === "h1" ? "Review 1 · 1–15" : `Review 2 · 16–${lastDay}`);

  return (
    <div className="gl-stack">
      <div className="gl-bar">
        <div className="gl-seg gs-months" role="group" aria-label="Month">
          {months.map((m) => <button key={m} type="button" className={month === m ? "on" : ""} aria-pressed={month === m} onClick={() => setMonth(m)}><span className="gs-ml">{monthName(m)}</span><span className="gs-ms">{monthName(m, "short")}</span></button>)}
        </div>
        <span className="gl-grow" />
        {canEdit && data.prevMonth && !saved.length && !dirty && (
          <button type="button" className="gl-btn" disabled={busy} onClick={copyLast}>{IC.copy}Copy {monthName(data.prevMonth.slice(0, 7))}</button>
        )}
        <span className="gs-who">{IC.lock}{canEdit ? "Goal editors set them · the lead types in the numbers" : "Set by your admin · you type in the numbers"}</span>
      </div>

      <div className="gs-wrap">
        <section className="gl-card gs-list" aria-label="Team Leads">
          <div className="gs-listhead"><b>Team Leads</b><span>on track</span></div>
          <div className="gs-people">
            {data.leads.map((l) => {
              const lr = drafts[l.id] ?? rowsOf(data.goals, l.id);
              const ls = lr.map(standing);
              const on = l.id === sel.id;
              return (
                <button key={l.id} type="button" className={"gs-person" + (on ? " on" : "")} aria-pressed={on} onClick={() => setSelId(l.id)}>
                  {l.imageUrl ? <img className="gl-ava sm" src={l.imageUrl} alt="" /> : <span className="gl-ava sm" style={{ background: gradFor(l.name) }}>{initials(l.name)}</span>}
                  <span>
                    <b>{l.name}</b>
                    <small>{dirtyLeads.includes(l.id) ? "Unsaved · " : ""}{lr.length ? `${lr.length} key result${lr.length === 1 ? "" : "s"}` : "No key results yet"}</small>
                  </span>
                  {lr.length > 0 && <em className={"gs-u " + (ls.every((s) => s.cls === "good") ? "good" : "warn")}>{ls.filter((s) => s.cls === "good").length}/{lr.length}</em>}
                </button>
              );
            })}
          </div>
        </section>

        <div className="gs-main">
          <section className="gl-card">
            <div className="gs-phead">
              {sel.imageUrl ? <img className="gl-ava md" src={sel.imageUrl} alt="" /> : <span className="gl-ava md" style={{ background: gradFor(sel.name) }}>{initials(sel.name)}</span>}
              <span>
                <b>{sel.name}</b>
                <small>{sel.designation || "Team Lead"} · {monthName(month)} key results · not part of the task score</small>
              </span>
            </div>
            <div className="gs-tiles">
              <div><b>{rows.length}</b><span>key results</span></div>
              <div><b>{onTrack}</b><span>on track</span></div>
              <div className="ac"><b>{team.length}</b><span>in the team</span></div>
            </div>
            <div className="gs-capline">
              <span className="gs-formula">
                Tactical meetings: Review 1 (1–15) · Review 2 (16–{lastDay})
                <small>Counts are typed in at each meeting · Followers comes from the {f.accounts} connected account{f.accounts === 1 ? "" : "s"}</small>
              </span>
            </div>
          </section>

          <section className="gl-card">
            <div className="gs-tscroll">
              <div className="gs-table lg-table">
                <div className="gs-row lg-r gs-th">
                  <span>Key result</span><span className="c">Target</span><span className="c">Review 1</span><span className="c">Review 2</span><span className="c">Month</span><span className="r">Standing</span>
                </div>
                {rows.length === 0 && (
                  <div className="gl-empty lg-empty">No key results for {first} in {monthName(month)} yet{canEdit ? " — add them below." : "."}</div>
                )}
                {rows.map((r, i) => {
                  const s = st[i];
                  const fol = r.kind === "followers";
                  return (
                    <div className="gs-row lg-r" key={r.id ?? `new-${i}`}>
                      <span className="lg-name">
                        {canEdit ? <input className="lg-in name" value={r.name} aria-label="Key result" onChange={(e) => patch(i, { name: e.target.value })} /> : <b>{r.name}</b>}
                        <small>{fol ? "From the connected accounts" : "Typed in at the meetings"}</small>
                      </span>
                      {canEdit
                        ? <input className="lg-in" type="number" min={0} value={r.target} placeholder="—" aria-label={`${r.name} target`} onChange={(e) => patch(i, { target: e.target.value })} />
                        : <b className="c lg-num">{r.target ? n0(Number(r.target)) : "—"}</b>}
                      {fol ? (
                        <>
                          <span className="c lg-auto"><b>{n0(r1Over ? f.r1 : f.now)}</b><small>{r1Over ? "on the 15th" : "now"}</small></span>
                          <span className="c lg-auto"><b>{n0(r2Over ? f.r2 : f.now)}</b><small>{r2Over ? "at month end" : r1Over ? "now" : "—"}</small></span>
                          <span className="c lg-auto"><b>{n0(f.now)}</b><small>{f.start != null ? `${f.now - f.start >= 0 ? "+" : ""}${n0(f.now - f.start)} this month` : "now"}</small></span>
                        </>
                      ) : (
                        <>
                          <span className="c lg-cell">
                            <input className="lg-in" type="number" min={0} value={r.r1} placeholder="—" aria-label={`${r.name} at Review 1`} onChange={(e) => patch(i, { r1: e.target.value })} />
                            <small className={num(r.r1) != null && s.r1t != null && (num(r.r1) ?? 0) >= s.r1t ? "met" : ""}>of {s.r1t != null ? n0(s.r1t) : "—"}</small>
                          </span>
                          <span className="c lg-cell">
                            <input className="lg-in" type="number" min={0} value={r.r2} placeholder="—" aria-label={`${r.name} at Review 2`} onChange={(e) => patch(i, { r2: e.target.value })} />
                            <small className={num(r.r2) != null && s.r2t != null && (num(r.r2) ?? 0) >= s.r2t ? "met" : ""}>of {s.r2t != null ? n0(s.r2t) : "—"}</small>
                          </span>
                          <span className="c lg-auto"><b>{n0(s.month)}</b><small>{s.pct != null ? `${Math.floor(s.pct * 100)}%` : "—"}</small></span>
                        </>
                      )}
                      <span className="r lg-st">
                        <em className={"gs-need " + s.cls}>{s.text}</em>
                        {canEdit && <button type="button" className="lg-x" aria-label={`Remove ${r.name}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>{IC.x}</button>}
                      </span>
                    </div>
                  );
                })}
                {canEdit && (
                  <div className="gs-row lg-r lg-add">
                    <span className="lg-name"><input className="lg-in name" value={newName} placeholder="Add a key result, e.g. Leads" aria-label="New key result" onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") add(); }} /></span>
                    <input className="lg-in" type="number" min={0} value={newTarget} placeholder="Target" aria-label="New key result target" onChange={(e) => setNewTarget(e.target.value)} />
                    <select className="lg-in" value={newKind} aria-label="Counted how" onChange={(e) => setNewKind(e.target.value as Kind)}>
                      <option value="count">Typed in</option>
                      <option value="followers">Followers</option>
                    </select>
                    <span />
                    <span />
                    <span className="r"><button type="button" className="gl-btn sm" disabled={!newName.trim()} onClick={() => add()}>{IC.plus}Add</button></span>
                  </div>
                )}
                {canEdit && missing.length > 0 && (
                  <div className="lg-sugg"><small>Quick add</small>{missing.map(([n, k]) => (
                    <button key={n} type="button" className="gl-btn sm" onClick={() => add(n, k, "")}>{IC.plus}{n}</button>
                  ))}</div>
                )}
              </div>
            </div>
            <p className="gs-hint">
              A count's Review 1 target is half the month's, Review 2 the rest — type in what the team reached at each Tactical meeting. Followers adds up every
              connected account's followers and fills itself in. These are the team's results, with the lead answering for them; they don't change anyone's task score.
            </p>
          </section>

          <section className="gl-card">
            <div className="lg-teamhead">
              <b>{first}'s team</b><span>each member's goals, as Team goals counts them</span>
              <span className="gl-grow" />
              <div className="gl-seg" role="group" aria-label="Review">
                {(["h1", "h2"] as const).map((h) => <button key={h} type="button" className={half === h ? "on" : ""} aria-pressed={half === h} onClick={() => setHalf(h)}>{halfLabel(h)}</button>)}
              </div>
            </div>
            {team.length === 0 ? <div className="gl-empty">No one has goals for {monthName(month)} yet — set them in Set goals.</div> : (
              <div className="lg-team">
                {teamSorted.map((m) => {
                  const h = m[half];
                  const cls = bandOf(h.pct);
                  return (
                    <div key={m.editorId} className="lg-member">
                      {m.imageUrl ? <img className="gl-ava sm" src={m.imageUrl} alt="" /> : <span className="gl-ava sm" style={{ background: gradFor(m.name) }}>{initials(m.name)}</span>}
                      <span className="lg-mname"><b>{m.name}</b><small>{h.target ? `${n0(h.done)} of ${n0(h.target)} jobs · ${h.missed ? `${h.missed} to discuss` : "all met"}` : "No goals this review"}</small></span>
                      <span className="lg-bar"><i className={cls} style={{ width: `${Math.min(100, (h.pct ?? 0) * 100)}%` }} /></span>
                      <b className={"lg-pct " + cls}>{h.pct != null ? `${Math.round(h.pct * 100)}%` : "—"}</b>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="gl-card gs-sum">
            <span className="gs-num"><b className="ac">{rows.length}</b><span>Key results</span></span>
            <span className="gs-num"><b>{onTrack}</b><span>On track</span></span>
            <span className="gs-num"><b>{team.filter((m) => (m[half].pct ?? 1) < 0.8).length}</b><span>To discuss</span></span>
            <span className="gb-say">{halfLabel(half)}: {team.filter((m) => (m[half].pct ?? 1) < 0.8).length ? "members under 80% are listed first, to talk through at the meeting." : "everyone is at 80% or more."}</span>
            <span className="gs-acts">
              {dirty && <button type="button" className="gl-btn" disabled={busy} onClick={() => setDrafts((d) => { const n = { ...d }; delete n[sel.id]; return n; })}>Discard</button>}
              <button type="button" className="gl-btn pri" disabled={!dirty || busy} onClick={save} title={!dirty ? "No changes" : undefined}>
                {IC.check}{busy ? "Saving…" : canEdit ? `Save ${first}'s key results` : "Save the numbers"}
              </button>
            </span>
          </section>
        </div>
      </div>
    </div>
  );
}
