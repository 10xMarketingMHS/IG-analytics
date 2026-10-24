import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useResource } from "@/lib/use-resource";
import { notifyTasksChanged, onTasksChanged } from "@/lib/task-events";
import { dateTime } from "@/lib/time-format";
import type { Task } from "@/lib/types";
import "./handover.css";

// Hand over (server/src/handover.js): pass your own task to a teammate. It
// stays yours, its timer paused, until they accept (then it's theirs, points
// and all) or decline. Unanswered, it climbs at each office close: Team Leads,
// then Asst. Managers, then Managers, and whoever it reaches can move it on.

export type HandoverItem = {
  id: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  taskRef: string | null;
  fromEditorId: string | null;
  fromName: string | null;
  fromImage: string | null;
  toEditorId: string | null;
  toName: string | null;
  toImage: string | null;
  note: string | null;
  level: number;
  createdAt: string;
  escalatedAt: string | null;
  // you offered it · it's offered to you · it has climbed to you (or you're an admin)
  mine: "from" | "to" | "reached";
  canMove: boolean;
  reachedLabel: string | null;
};
export type HandoverPerson = { id: string; name: string; designation: string | null; imageUrl: string | null };
type HandoverData = { ready: boolean; people: HandoverPerson[]; items: HandoverItem[] };

export function useHandovers() {
  const { data, refetch } = useResource<HandoverData>("/handovers");
  // Fresh after any task change, and every minute while the page is open (an
  // offer can arrive any time).
  useEffect(() => onTasksChanged(() => { refetch().catch(() => {}); }), [refetch]);
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") refetch().catch(() => {}); }, 60_000);
    return () => window.clearInterval(t);
  }, [refetch]);
  const items = useMemo(() => data?.items ?? [], [data]);
  const byTask = useMemo(() => new Map(items.map((h) => [h.taskId, h])), [items]);
  return { ready: data?.ready ?? false, people: data?.people ?? [], items, byTask, refetch };
}

async function post(path: string, body: object | undefined, done: string) {
  try {
    await api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    toast.success(done);
    notifyTasksChanged();
    return true;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : "That didn't go through. Check your connection and try again.");
    return false;
  }
}

const HO_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 7h11l-3-3M17 17H6l3 3" />
  </svg>
);

const climbLine = (h: HandoverItem) => (h.level > 0 && h.reachedLabel ? `Not accepted yet, so it has gone to the ${h.reachedLabel}.` : null);

function PersonPick({ people, value, onChange, label, selfId }: { people: HandoverPerson[]; value: string; onChange: (v: string) => void; label: string; selfId?: string | null }) {
  return (
    <select className="ho-in" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">Pick a teammate…</option>
      {selfId && <option value={selfId}>Me (I'll do it)</option>}
      {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` · ${p.designation}` : ""}</option>)}
    </select>
  );
}

// In a task's panel: Hand over (your own task), what's waiting, or Move it on.
export function HandoverBlock({ task, onChanged }: { task: Task; onChanged?: () => void }) {
  const { user } = useAuth();
  const { ready, people, byTask } = useHandovers();
  const [mode, setMode] = useState<null | "offer" | "decline" | "move">(null);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const h = byTask.get(task.id);
  useEffect(() => { setMode(null); setTo(""); setNote(""); }, [task.id, h?.id]);
  if (!ready) return null;

  async function run(path: string, body: object | undefined, done: string) {
    setBusy(true);
    const ok = await post(path, body, done);
    setBusy(false);
    if (ok) { setMode(null); setTo(""); setNote(""); onChanged?.(); }
  }

  const mine = !!user?.editorId && task.editor_id === user.editorId;
  if (!h) {
    if (!mine || !task.accepted || (task.status !== "todo" && task.status !== "in_progress")) return null;
    if (mode !== "offer") {
      return (
        <div className="ho-box">
          <span className="ho-ic">{HO_ICON}</span>
          <span className="ho-tx"><b>Can't finish this?</b><small>Hand it over to a teammate. It stays yours until they accept.</small></span>
          <button type="button" className="ho-btn" onClick={() => setMode("offer")}>Hand over</button>
        </div>
      );
    }
    const pick = people.find((p) => p.id === to);
    return (
      <div className="ho-box col">
        <b className="ho-title">Hand over to</b>
        <PersonPick people={people} value={to} onChange={setTo} label="Hand over to" />
        <input className="ho-in" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why? For example, on leave tomorrow (optional)" />
        <small className="ho-faint">
          {pick ? `${pick.name} gets a notice to accept or decline. ` : ""}Your timer pauses until they answer. Once they accept, the task and its points are theirs.
        </small>
        <div className="ho-acts">
          <button type="button" className="ho-btn ghost" onClick={() => setMode(null)} disabled={busy}>Cancel</button>
          <button type="button" className="ho-btn pri" disabled={!to || busy}
            onClick={() => run(`/tasks/${task.id}/handover`, { toEditorId: to, note: note.trim() || undefined }, `Sent to ${pick?.name ?? "your teammate"} to accept.`)}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    );
  }

  if (h.mine === "to") {
    return (
      <div className="ho-box col on">
        <span className="ho-row"><span className="ho-ic">{HO_ICON}</span><b className="ho-title">{h.fromName ?? "A teammate"} wants to hand this to you</b></span>
        {h.note && <span className="ho-note">“{h.note}”</span>}
        <small className="ho-faint">Sent {dateTime(h.createdAt)}. Accept it and the task, and its points, are yours.</small>
        {mode === "decline" ? (
          <>
            <input className="ho-in" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why not? (optional)" autoFocus />
            <div className="ho-acts">
              <button type="button" className="ho-btn ghost" onClick={() => setMode(null)} disabled={busy}>Back</button>
              <button type="button" className="ho-btn warn" disabled={busy}
                onClick={() => run(`/handovers/${h.id}/decline`, { note: note.trim() || undefined }, `Declined. It stays with ${h.fromName ?? "its owner"}.`)}>
                {busy ? "Declining…" : "Decline"}
              </button>
            </div>
          </>
        ) : (
          <div className="ho-acts">
            <button type="button" className="ho-btn ghost" onClick={() => setMode("decline")} disabled={busy}>Decline</button>
            <button type="button" className="ho-btn pri" disabled={busy} onClick={() => run(`/handovers/${h.id}/accept`, undefined, "It's yours now.")}>
              {busy ? "Accepting…" : "Accept"}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (h.mine === "from") {
    return (
      <div className="ho-box col wait">
        <span className="ho-row"><span className="ho-ic">{HO_ICON}</span><b className="ho-title">Waiting for {h.toName ?? "your teammate"} to accept</b></span>
        <small className="ho-faint">Sent {dateTime(h.createdAt)}. It stays yours, with the timer paused, until they answer.</small>
        {climbLine(h) && <small className="ho-climb">{climbLine(h)}</small>}
        <div className="ho-acts">
          <button type="button" className="ho-btn ghost" disabled={busy} onClick={() => run(`/handovers/${h.id}/cancel`, undefined, "Hand-over called off. It's back with you.")}>
            {busy ? "Calling off…" : "Call off"}
          </button>
        </div>
      </div>
    );
  }

  // It has climbed to you (or you're an admin): move it to whoever should do it.
  return (
    <div className="ho-box col wait">
      <span className="ho-row"><span className="ho-ic">{HO_ICON}</span><b className="ho-title">{h.toName ?? "A teammate"} hasn't accepted this from {h.fromName ?? "its owner"}</b></span>
      <small className="ho-faint">Handed over {dateTime(h.createdAt)}.</small>
      {climbLine(h) && <small className="ho-climb">{climbLine(h)}</small>}
      {h.canMove && (mode === "move" ? (
        <>
          <PersonPick people={people} selfId={user?.editorId} value={to} onChange={setTo} label="Move it to" />
          <small className="ho-faint">They get it like any assigned task and accept it from their board.</small>
          <div className="ho-acts">
            <button type="button" className="ho-btn ghost" onClick={() => setMode(null)} disabled={busy}>Back</button>
            <button type="button" className="ho-btn pri" disabled={!to || busy}
              onClick={() => run(`/handovers/${h.id}/move`, { toEditorId: to }, to === user?.editorId ? "It's yours now." : `Moved to ${people.find((p) => p.id === to)?.name ?? "them"}.`)}>
              {busy ? "Moving…" : "Move"}
            </button>
          </div>
        </>
      ) : (
        <div className="ho-acts">
          <button type="button" className="ho-btn pri" onClick={() => setMode("move")}>Move to someone</button>
        </div>
      ))}
    </div>
  );
}

// On a task card: who it's waiting on.
export function HandoverPill({ h }: { h: HandoverItem }) {
  const late = h.level > 0;
  return (
    <span className={"ho-pill" + (late ? " late" : "")} title={late && h.reachedLabel ? `Not accepted yet. It has gone to the ${h.reachedLabel}.` : "Handed over, waiting to be accepted"}>
      {HO_ICON}<span>To {h.toName ?? "a teammate"} · {late ? "not accepted" : "waiting"}</span>
    </span>
  );
}

// Home and the Task Board: hand-overs that need you (offered to you, or ones
// that have climbed to you). Nothing shows when there are none.
export function HandoverInbox({ onOpen }: { onOpen: (taskId: string) => void }) {
  const { ready, items } = useHandovers();
  const [busy, setBusy] = useState<string | null>(null);
  const mineToDo = items.filter((h) => h.mine === "to" || (h.mine === "reached" && h.canMove && h.level > 0));
  if (!ready || mineToDo.length === 0) return null;
  async function run(id: string, path: string, done: string) {
    setBusy(id);
    await post(path, undefined, done);
    setBusy(null);
  }
  return (
    <section className="ho-inbox" aria-label="Hand-overs for you">
      <div className="ho-inbox-head">{HO_ICON}<b>Hand-overs for you</b><span className="ho-count">{mineToDo.length}</span></div>
      {mineToDo.map((h) => (
        <div className="ho-item" key={h.id}>
          <button type="button" className="ho-item-main" onClick={() => onOpen(h.taskId)}>
            <span className="ho-item-title">{h.taskRef ? <span className="ho-ref">{h.taskRef}</span> : null}{h.taskTitle}</span>
            <small>
              {h.mine === "to"
                ? `From ${h.fromName ?? "a teammate"}${h.note ? `: “${h.note}”` : ""}`
                : `${h.toName ?? "A teammate"} hasn't accepted it from ${h.fromName ?? "its owner"}. Tap to move it on.`}
            </small>
          </button>
          {h.mine === "to" && (
            <span className="ho-item-acts">
              <button type="button" className="ho-btn ghost sm" disabled={busy === h.id} onClick={() => run(h.id, `/handovers/${h.id}/decline`, `Declined. It stays with ${h.fromName ?? "its owner"}.`)}>Decline</button>
              <button type="button" className="ho-btn pri sm" disabled={busy === h.id} onClick={() => run(h.id, `/handovers/${h.id}/accept`, "It's yours now.")}>Accept</button>
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
