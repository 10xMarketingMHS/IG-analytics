import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { SI } from "@/pages/settings-ui";
import "./page-access.css";

// Settings › Page access (server/src/routes/page-access.js): what each position
// may see and change, page by page. See puts a page in the person's menu and
// lets them open it; Change lets them use its buttons. A row takes effect once
// it's saved; until then its people keep today's rules. The Super Admin sets
// every row; an admin only the rows below their own, with ticks their row has.

type Tick = { see: boolean; change: boolean };
type Ticks = Record<string, Tick>;
type PageMeta = { key: string; group: string; label: string; see: true | "on"; change: boolean | "super"; does?: string };
type Person = { name: string; admin: boolean; super: boolean };
type Row = { key: string; label: string; rank: number; people: Person[]; saved: boolean; savedAt: string | null; savedByName: string | null; pages: Ticks };
type Data = { pages: PageMeta[]; rows: Row[]; me: { super: boolean; row: string }; editable: string[]; own: Ticks | null };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const same = (a: Ticks, b: Ticks) => Object.keys(a).every((k) => a[k].see === b[k]?.see && a[k].change === b[k]?.change);
// the cards: each group's pages, five at most to a card
function cardsOf(pages: PageMeta[]) {
  const groups: { title: string; pages: PageMeta[] }[] = [];
  for (const p of pages) {
    const last = groups[groups.length - 1];
    if (last && last.pages[0].group === p.group) last.pages.push(p);
    else groups.push({ title: p.group, pages: [p] });
  }
  return groups.flatMap((g) => {
    if (g.pages.length <= 5) return [g];
    const half = Math.ceil(g.pages.length / 2);
    return [{ title: `${g.title} (1 of 2)`, pages: g.pages.slice(0, half) }, { title: `${g.title} (2 of 2)`, pages: g.pages.slice(half) }];
  });
}

function Mark({ on, locked, disabled, label, onClick }: { on: boolean; locked?: boolean; disabled?: string; label: string; onClick?: () => void }) {
  return (
    <button type="button" className={"pa-tick" + (on ? " on" : "") + (locked ? " locked" : "")} aria-pressed={on} aria-label={label}
      title={locked ? "Always on" : disabled} disabled={locked || !!disabled} onClick={onClick}>
      {on ? SI.check : null}
    </button>
  );
}

export function PageAccessSection() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Ticks>>({});
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const d = await api<Data>("/page-access");
      setData(d);
      setDraft(Object.fromEntries(d.rows.map((r) => [r.key, r.pages])));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load page access.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const cards = useMemo(() => (data ? cardsOf(data.pages) : []), [data]);

  if (error) return <section className="st-card"><div className="st-empty">{error}</div></section>;
  if (!data) return <section className="st-card"><div className="st-empty">Loading…</div></section>;
  const dirty = data.rows.filter((r) => draft[r.key] && !same(draft[r.key], r.pages));
  const canSet = (row: string) => data.editable.includes(row);
  // why a tick can't be set by you (or undefined when it can)
  const why = (row: string, page: string, mode: "see" | "change") =>
    !canSet(row) ? (data.me.super ? undefined : "You can set only the positions below your own")
      : data.own && !data.own[page]?.[mode] ? "Your own position doesn't have this" : undefined;

  function flip(row: string, p: PageMeta, mode: "see" | "change") {
    setDraft((d) => {
      const cur = d[row][p.key];
      const next = mode === "change"
        ? { see: cur.see || !cur.change, change: !cur.change }
        : { see: !cur.see, change: cur.see ? false : cur.change };
      return { ...d, [row]: { ...d[row], [p.key]: next } };
    });
  }
  async function save() {
    setBusy(true);
    try {
      for (const r of dirty) await api(`/page-access/rows/${r.key}`, { method: "PUT", body: JSON.stringify({ pages: draft[r.key] }) });
      toast.success(dirty.length === 1 ? `${dirty[0].label}: saved. It's their rule now.` : `Saved ${dirty.length} positions. It's their rule now.`);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save page access.");
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function reset(r: Row) {
    if (!window.confirm(`Put ${r.label}s back on today's rules? Their saved ticks are dropped.`)) return;
    try {
      await api(`/page-access/rows/${r.key}`, { method: "DELETE" });
      toast.success(`${r.label}s are back on today's rules.`);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't reset it.");
    }
  }

  return (
    <>
      <section className="st-card">
        <div className="st-cardhead">
          <b>Positions</b>
          <span>
            Each position is a row: <strong>See</strong> puts a page in their menu and lets them open it, <strong>Change</strong> lets them use its buttons.
            Until a row is saved, its people keep today's access. Once saved, it's the rule for everyone in it, admins included.
          </span>
        </div>
        {data.rows.map((r) => {
          const admins = r.people.filter((p) => p.admin && !p.super);
          return (
            <div key={r.key} className="st-row">
              <span className="st-label">
                <b>{r.label}{r.key === data.me.row ? " · you" : ""}</b>
                <small>
                  {r.people.length ? r.people.map((p) => p.name + (p.super ? " (Super Admin)" : p.admin ? " (admin)" : "")).join(", ") : "Nobody yet"}
                  {!r.saved && admins.length > 0 && ` · saving this row sets ${admins.length === 1 ? `${admins[0].name}'s access` : "these admins' access"} too`}
                </small>
              </span>
              <span className={"pa-state" + (r.saved ? " saved" : "")}>
                {r.saved ? `Saved ${r.savedAt ? day(r.savedAt) : ""}${r.savedByName ? ` by ${r.savedByName}` : ""}` : "Today's rules"}
              </span>
              {r.saved && canSet(r.key) && <button type="button" className="st-btn sm" onClick={() => reset(r)}>Reset</button>}
            </div>
          );
        })}
        <div className="st-foot">
          <span className="st-note">
            {SI.info} The Super Admin sees and changes everything. Some things stay theirs alone: the work calendar, task points,
            attendance penalties, scoring and Access. Extra permissions given to one person in Access come on top, and anyone with
            a Schedule goal gets Scheduling.{data.me.super ? "" : " You can set the positions below your own, with ticks your own position has."}
          </span>
        </div>
      </section>

      {cards.map((c) => (
        <section key={c.title} className="st-card">
          <div className="st-cardhead"><b>{c.title}</b></div>
          <div className="pa-scroll">
            <table className="pa-grid">
              <colgroup><col className="pa-rowcol" />{c.pages.map((p) => <Fragment key={p.key}><col /><col /></Fragment>)}</colgroup>
              <thead>
                <tr>
                  <th />
                  {c.pages.map((p) => (
                    <th key={p.key} colSpan={2} className="pa-page">
                      <span>{p.label}</span>
                      {p.does && <small>Change: {p.does}</small>}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th className="pa-poshead">Position</th>
                  {c.pages.map((p) => (
                    <Fragment key={p.key}><th className="pa-sub first">See</th><th className="pa-sub">Change</th></Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="pa-super">
                  <td className="pa-pos">Super Admin {SI.lock}</td>
                  {c.pages.map((p) => (
                    <Fragment key={p.key}>
                      <td className="first"><Mark on locked label={`Super Admin sees ${p.label}`} /></td>
                      <td>{p.change ? <Mark on locked label={`Super Admin changes ${p.label}`} /> : <span className="pa-none">—</span>}</td>
                    </Fragment>
                  ))}
                </tr>
                {data.rows.map((r) => {
                  const t = draft[r.key] ?? r.pages;
                  const changed = dirty.some((x) => x.key === r.key);
                  return (
                    <tr key={r.key} className={changed ? "pa-dirty" : ""}>
                      <td className="pa-pos">
                        {r.label}
                        <span className="pa-n" title={r.people.map((p) => p.name).join(", ") || "Nobody yet"}>{r.people.length}</span>
                      </td>
                      {c.pages.map((p) => (
                        <Fragment key={p.key}>
                          <td className="first">
                            <Mark on={t[p.key].see} locked={p.see === "on"} disabled={why(r.key, p.key, "see")}
                              label={`${r.label} sees ${p.group} › ${p.label}`} onClick={() => flip(r.key, p, "see")} />
                          </td>
                          <td>
                            {p.change === true
                              ? <Mark on={t[p.key].change} disabled={why(r.key, p.key, "change")}
                                  label={`${r.label} changes ${p.group} › ${p.label}`} onClick={() => flip(r.key, p, "change")} />
                              : p.change === "super" ? <span className="pa-none" title="The Super Admin's alone">{SI.lock}</span>
                              : <span className="pa-none">—</span>}
                          </td>
                        </Fragment>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {dirty.length > 0 && (
        <div className="pa-bar" role="status">
          <span>Unsaved: {dirty.map((r) => r.label).join(", ")}</span>
          <button type="button" className="st-btn" disabled={busy} onClick={() => setDraft(Object.fromEntries(data.rows.map((r) => [r.key, r.pages])))}>Discard</button>
          <button type="button" className="st-btn pri" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      )}
    </>
  );
}
