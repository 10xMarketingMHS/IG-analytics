import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { ContentFormatDef, Editor } from "@/lib/types";

// Task Board › Add finished work (Admins and the Super Admin): work someone did
// before they were on Echo, or that never reached the board, added as done on
// the day it was done (POST /tasks/finished). It counts like approved work:
// goal jobs toward their goal, other work by its hours. This month only.
const CAT_LABEL: Record<string, string> = { social: "Social", ad: "Ads", service: "Service", project: "Project" };
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

export function FinishedWorkDialog({ editors, formats, brands, myEditorId, onClose, onAdded }: {
  editors: Editor[];
  formats: ContentFormatDef[];
  brands: { id: string; name: string }[];
  myEditorId: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const today = istToday();
  const people = useMemo(() => editors.filter((e) => e.active !== false && e.id !== myEditorId).sort((a, b) => a.name.localeCompare(b.name)), [editors, myEditorId]);
  // the types work can be added as: active, and not a main type that's only a heading for its sub-types
  const types = useMemo(() => {
    const parents = new Set(formats.map((f) => f.parent_id).filter(Boolean));
    return formats.filter((f) => f.active && f.category && !parents.has(f.id))
      .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }, [formats]);
  const [editorId, setEditorId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");
  const [count, setCount] = useState("1");
  const [date, setDate] = useState(today);
  const [hours, setHours] = useState("");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const type = types.find((t) => t.id === typeId) ?? null;
  const person = people.find((p) => p.id === editorId) ?? null;
  const n = Math.floor(Number(count));
  const offGoal = type?.counts_in_goal === false;

  async function add() {
    if (!person) return setErr("Pick who did it.");
    if (!type) return setErr("Pick its type.");
    if (!brandId) return setErr("Pick its brand.");
    if (!(n >= 1 && n <= 100)) return setErr("How many: 1 to 100.");
    if (!date || date > today || date < `${today.slice(0, 8)}01`) return setErr("Pick a day this month, today or earlier.");
    const h = hours.trim() ? Number(hours) : null;
    if (h != null && !(h >= 0.25 && h <= 200)) return setErr("Hours each: at least 0.25.");
    setBusy(true); setErr(null);
    try {
      const r = await api<{ added: number }>("/tasks/finished", {
        method: "POST",
        body: JSON.stringify({ editorId: person.id, contentFormatId: type.id, channelId: brandId, count: n, date, hoursEach: h, title: title.trim() || undefined, deliveryLink: link.trim() || null, note: note.trim() || undefined }),
      });
      toast.success(`Added ${r.added} finished ${type.name}${r.added > 1 ? " jobs" : ""} for ${person.name}, done ${dayLabel(date)}.`);
      onAdded();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't add the finished work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg show" onClick={onClose}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add finished work">
        <div className="mhead">
          <span style={{ fontSize: 18 }}>✅</span>
          <h3>Add finished work</h3>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="mbody">
          <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.6, color: "var(--muted)" }}>
            For work already done this month that isn't on the board, like the days before someone joined Echo. It's added as approved, on the day it was done.
          </p>
          <div className="grid g2">
            <div className="field">
              <label className="f">Who did it <span className="req">*</span></label>
              <select className="t" value={editorId} onChange={(e) => { setEditorId(e.target.value); setErr(null); }}>
                <option value="">Pick a person…</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` · ${p.designation}` : ""}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="f">Type of work <span className="req">*</span></label>
              <select className="t" value={typeId} onChange={(e) => { setTypeId(e.target.value); setErr(null); }}>
                <option value="">Pick a type…</option>
                {Object.entries(CAT_LABEL).map(([cat, label]) => {
                  const list = types.filter((t) => t.category === cat);
                  return list.length ? (
                    <optgroup key={cat} label={label}>
                      {list.map((t) => <option key={t.id} value={t.id}>{t.name}{t.counts_in_goal === false ? " (not in goals)" : ""}</option>)}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </div>
            <div className="field">
              <label className="f">How many <span className="req">*</span></label>
              <input className="t" type="number" min={1} max={100} step={1} value={count} onChange={(e) => { setCount(e.target.value); setErr(null); }} />
            </div>
            <div className="field">
              <label className="f">Day it was done <span className="req">*</span></label>
              <input className="t" type="date" min={`${today.slice(0, 8)}01`} max={today} value={date} onChange={(e) => { setDate(e.target.value); setErr(null); }} />
            </div>
            <div className="field">
              <label className="f">Brand <span className="req">*</span></label>
              <select className="t" value={brandId} onChange={(e) => { setBrandId(e.target.value); setErr(null); }}>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="f">Hours each <span style={{ fontWeight: 500, color: "var(--faint)" }}>· {offGoal ? "what it counts" : "optional"}</span></label>
              <input className="t" type="number" min={0.25} step={0.25} value={hours} placeholder={type?.hours ? `${type.hours} (the type's time)` : "The type's time"}
                onChange={(e) => { setHours(e.target.value); setErr(null); }} />
            </div>
          </div>
          <div className="field">
            <label className="f">Title <span style={{ fontWeight: 500, color: "var(--faint)" }}>· optional</span></label>
            <input className="t" value={title} maxLength={200} placeholder={type ? `${type.name}${n > 1 ? " 1, 2…" : ""}` : "What the work was"} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid g2">
            <div className="field">
              <label className="f">Link to the work <span style={{ fontWeight: 500, color: "var(--faint)" }}>· optional</span></label>
              <input className="t" value={link} placeholder="https://drive.google.com/…" onChange={(e) => { setLink(e.target.value); setErr(null); }} />
            </div>
            <div className="field">
              <label className="f">Note <span style={{ fontWeight: 500, color: "var(--faint)" }}>· optional</span></label>
              <input className="t" value={note} maxLength={500} placeholder="Why it's added afterwards" onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          {person && type && n >= 1 && (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              Adds <b>{n} {type.name}{n > 1 ? " jobs" : ""}</b> for <b>{person.name}</b>, done <b>{dayLabel(date)}</b>.{" "}
              {offGoal ? "Not a goal type, so it counts by its hours, filling any goal they're short on." : "Counts toward their goal like approved work."}
            </p>
          )}
          {err && <p role="alert" style={{ margin: "10px 0 0", fontSize: 13, color: "var(--rose, #e11d48)" }}>{err}</p>}
        </div>
        <div className="mfoot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={add}>{busy ? "Adding…" : "Add finished work"}</button>
        </div>
      </div>
    </div>
  );
}
