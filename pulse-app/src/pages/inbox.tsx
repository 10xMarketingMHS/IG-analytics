import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Avatar } from "@/lib/editor-visuals";
import { relTime } from "@/lib/activity-meta";
import { clockTime } from "@/lib/time-format";
import { notifyTasksChanged } from "@/lib/task-events";
import { attendanceAction, cancelMyLeave, leaveAction, leaveWords } from "@/lib/use-attendance";
import { useInbox, type InboxItem } from "@/lib/use-inbox";
import type { Editor } from "@/lib/types";
import "./inbox.css";

// The Inbox: everything waiting on you in one place, answered right here —
// leave, permission and start-time correction requests from your people
// (Approve / Decline), hand-overs (Accept / Decline, or open to move it on),
// work to review and tasks to accept (open them), password resets (admins).
// "Sent by you" is what you asked for that's still waiting on someone.
// Laid out like the Social & Ads Pipeline table: one panel, a row per item
// with its kind's colour down the left edge. Data: lib/use-inbox.ts.

type Kind = InboxItem["kind"];
// kinds in the order they're listed and filtered, with their words
const KINDS: { k: Kind; label: string; tag: string }[] = [
  { k: "leave", label: "Leave", tag: "LEAVE" },
  { k: "permission", label: "Permissions", tag: "PERMISSION" },
  { k: "correction", label: "Corrections", tag: "CORRECTION" },
  { k: "handover", label: "Hand-overs", tag: "HAND-OVER" },
  { k: "review", label: "Reviews", tag: "REVIEW" },
  { k: "accept", label: "To accept", tag: "TO ACCEPT" },
  { k: "reset", label: "Password resets", tag: "PASSWORD" },
];
const ORDER = new Map(KINDS.map((x, i) => [x.k, i]));
const TAG = new Map(KINDS.map((x) => [x.k, x.tag]));
const ICON: Record<Kind, string> = { leave: "🌴", permission: "⏱️", correction: "🕘", handover: "🔁", review: "👀", accept: "📥", reset: "🔑" };
const day = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const n1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Person({ name, imageUrl, kind }: { name?: string | null; imageUrl?: string | null; kind: Kind }) {
  if (!name) return <span className="ib-person"><span className="ib-ic" aria-hidden="true">{ICON[kind]}</span><span className="ib-faint">—</span></span>;
  return (
    <span className="ib-person">
      <span className="ib-face"><Avatar editor={{ id: name, name, designation: "", image_url: imageUrl ?? null, active: true } as Editor} /></span>
      <b>{name}</b>
    </span>
  );
}

export function InboxPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, refresh } = useInbox(user?.id ?? "");
  const [tab, setTab] = useState<"waiting" | "sent">("waiting");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const openTask = (taskId: string) => navigate("/tasks", { state: { openTask: taskId } });

  // one answer at a time per item; the Inbox reloads after it
  async function act(key: string, run: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await run();
      toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That didn't go through. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }
  const handoverPost = async (path: string) => { await api(path, { method: "POST" }); notifyTasksChanged(); };

  // a row: what it is, who, the details, when, and the answer
  function row(i: InboxItem, sent: boolean): ReactNode {
    const off = busy === i.key;
    const btn = (label: string, onClick: () => void, cls = "") => (
      <button type="button" className={"ib-btn " + cls} disabled={off} onClick={(e) => { e.stopPropagation(); onClick(); }}>{label}</button>
    );
    let what: ReactNode = null;
    let who: ReactNode = <Person kind={i.kind} />;
    let details: ReactNode = null;
    let acts: ReactNode = null;
    let open: (() => void) | null = null;
    switch (i.kind) {
      case "leave": {
        const l = i.leave;
        what = <>{leaveWords(l)}{l.shortNotice && <span className="ib-tag warn">short notice</span>}</>;
        who = sent ? <Person name="Your lead" kind="leave" /> : <Person name={i.name} imageUrl={i.imageUrl} kind="leave" />;
        const b = i.balance;
        const bal = !sent && l.kind === "cl" && b
          ? b.perYear ? `${n1(Math.max(0, b.perYear - b.cl))} of ${n1(b.perYear)} CL left${b.unpaid ? `, ${n1(b.unpaid)} unpaid` : ""}` : "No CL set (unpaid)"
          : null;
        details = <>{l.note ? <span>“{l.note}”</span> : null}{bal ? <span className="ib-faint">{bal}</span> : null}{!l.note && !bal ? <span className="ib-faint">{sent ? "Waiting for your lead" : "—"}</span> : null}</>;
        acts = sent
          ? btn("Cancel", () => act(i.key, () => cancelMyLeave(l.id), "Leave cancelled."), "ghost")
          : <>{btn("Decline", () => act(i.key, () => leaveAction(i.editorId!, l.id, "decline"), "Leave declined."), "ghost")}
             {btn("Approve", () => act(i.key, () => leaveAction(i.editorId!, l.id, "approve"), `${i.name?.split(" ")[0]}'s leave approved.`), "good")}</>;
        break;
      }
      case "permission":
        what = <>{i.part === "morning" ? "Morning permission" : "Evening permission"} · {day(i.date)}</>;
        who = sent ? <Person name="Your lead" kind="permission" /> : <Person name={i.name} imageUrl={i.imageUrl} kind="permission" />;
        details = <>{i.note ? <span>“{i.note}”</span> : null}<span className="ib-faint">{i.part === "morning" ? "Come in late, up to 2 hours" : "Leave early, up to 2 hours"}</span></>;
        acts = sent ? <span className="ib-faint">Waiting</span>
          : <>{btn("Decline", () => act(i.key, () => attendanceAction(i.editorId!, "permission", { id: i.id, approve: false }), "Permission declined."), "ghost")}
             {btn("Approve", () => act(i.key, () => attendanceAction(i.editorId!, "permission", { id: i.id, approve: true }), "Permission approved."), "good")}</>;
        break;
      case "correction":
        what = <>Start at {clockTime(i.correctionAt)}{i.date !== new Date().toLocaleDateString("en-CA") ? ` on ${day(i.date)}` : ""}</>;
        who = <Person name={i.name} imageUrl={i.imageUrl} kind="correction" />;
        details = <>{i.note ? <span>“{i.note}”</span> : null}<span className="ib-faint">{i.checkInAt ? `Opened Pulse at ${clockTime(i.checkInAt)}` : "Not opened yet"}</span></>;
        acts = <>{btn("Decline", () => act(i.key, () => attendanceAction(i.editorId, "correction", { approve: false }), "Correction declined."), "ghost")}
          {btn("Approve", () => act(i.key, () => attendanceAction(i.editorId, "correction", { approve: true }), "Start time corrected."), "good")}</>;
        break;
      case "handover": {
        const h = i.handover;
        what = <>{h.taskRef && <span className="ib-ref">{h.taskRef}</span>}{h.taskTitle}</>;
        who = <Person name={sent ? h.toName : h.mine === "to" ? h.fromName : h.toName} imageUrl={sent ? h.toImage : h.mine === "to" ? h.fromImage : h.toImage} kind="handover" />;
        details = sent
          ? <span className="ib-faint">Offered to {h.toName ?? "a teammate"}{h.level > 0 && h.reachedLabel ? ` · now with ${h.reachedLabel}` : ""}</span>
          : h.mine === "to"
            ? <>{h.note ? <span>“{h.note}”</span> : null}<span className="ib-faint">From {h.fromName ?? "a teammate"}</span></>
            : <span className="ib-faint">{h.toName ?? "A teammate"} hasn't accepted it from {h.fromName ?? "its owner"}. Open it to move it on.</span>;
        open = () => openTask(h.taskId);
        acts = sent
          ? btn("Take back", () => act(i.key, () => handoverPost(`/handovers/${h.id}/cancel`), "Hand-over taken back."), "ghost")
          : h.mine === "to"
            ? <>{btn("Decline", () => act(i.key, () => handoverPost(`/handovers/${h.id}/decline`), `Declined. It stays with ${h.fromName ?? "its owner"}.`), "ghost")}
               {btn("Accept", () => act(i.key, () => handoverPost(`/handovers/${h.id}/accept`), "It's yours now."), "good")}</>
            : btn("Open", () => openTask(h.taskId), "pri");
        break;
      }
      case "review":
        what = <>{i.ref && <span className="ib-ref">{i.ref}</span>}{i.title}</>;
        who = <Person name={sent ? i.reviewBy : i.name} imageUrl={sent ? null : i.imageUrl} kind="review" />;
        details = <span className="ib-faint">{sent ? `Waiting for ${i.reviewBy ?? "a reviewer"}` : "Waiting for your review"}</span>;
        open = () => openTask(i.taskId);
        acts = btn("Open", () => openTask(i.taskId), sent ? "ghost" : "pri");
        break;
      case "accept":
        what = <>{i.ref && <span className="ib-ref">{i.ref}</span>}{i.title}</>;
        who = <Person name={i.name} kind="accept" />;
        details = <span className="ib-faint">{i.due ? `Due ${day(i.due)}` : "No due date"}</span>;
        open = () => openTask(i.taskId);
        acts = btn("Open", () => openTask(i.taskId), "pri");
        break;
      case "reset":
        what = <>Forgot their password</>;
        who = <Person name={i.name} kind="reset" />;
        details = <span className="ib-faint">Set a new one on Team › Roster</span>;
        acts = btn("Open Roster", () => navigate("/my-team?tab=roster"), "pri");
        break;
    }
    return (
      <div key={i.key} className={"ib-tr k-" + i.kind + (open ? " link" : "")} role={open ? "button" : undefined} tabIndex={open ? 0 : undefined}
        onClick={open ?? undefined} onKeyDown={open ? (e) => { if (e.key === "Enter") open!(); } : undefined}>
        <span className="ib-what"><b>{what}</b><span><em className="ib-type">{TAG.get(i.kind)}</em></span></span>
        {who}
        <span className="ib-details">{details}</span>
        <span className="ib-when">{relTime(i.at)}</span>
        <span className="ib-acts">{acts}</span>
      </div>
    );
  }

  const all = tab === "waiting" ? data?.waiting ?? [] : data?.sent ?? [];
  const counts = KINDS.map((x) => ({ ...x, n: all.filter((i) => i.kind === x.k).length })).filter((x) => x.n > 0);
  const shown = kind === "all" ? all : all.filter((i) => i.kind === kind);
  // grouped by kind, newest first within each
  const rows = [...shown].sort((a, b) => (ORDER.get(a.kind)! - ORDER.get(b.kind)!) || new Date(b.at).getTime() - new Date(a.at).getTime());
  const pickTab = (t: "waiting" | "sent") => { setTab(t); setKind("all"); };
  return (
    <section className="screen ib">
      <div className="ib-bar">
        <div className="ib-seg" role="tablist" aria-label="Inbox">
          <button type="button" role="tab" aria-selected={tab === "waiting"} className={tab === "waiting" ? "on" : ""} onClick={() => pickTab("waiting")}>
            Waiting on you{data ? <span className={"ib-n" + (data.waiting.length ? " hot" : "")}>{data.waiting.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === "sent"} className={tab === "sent" ? "on" : ""} onClick={() => pickTab("sent")}>
            Sent by you{data ? <span className="ib-n">{data.sent.length}</span> : null}
          </button>
        </div>
        {counts.length > 1 && (
          <div className="ib-seg" role="group" aria-label="Show">
            <button type="button" className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>All<span className="ib-n">{all.length}</span></button>
            {counts.map((x) => (
              <button key={x.k} type="button" className={kind === x.k ? "on" : ""} onClick={() => setKind(x.k)}>{x.label}<span className="ib-n">{x.n}</span></button>
            ))}
          </div>
        )}
        <span className="ib-grow" />
        {data && <span className="ib-showing">Showing <b>{rows.length}</b></span>}
      </div>
      <div className="ib-panel">
        {!data ? (
          <div className="ib-none">Loading your Inbox…</div>
        ) : rows.length === 0 ? (
          <div className="ib-none">
            {tab === "waiting" ? "Nothing is waiting on you. Requests, hand-overs and reviews land here." : "Nothing you sent is waiting on anyone."}
          </div>
        ) : (
          <div className="ib-scroll">
            <div className="ib-grid">
              <div className="ib-th"><span>Request</span><span>{tab === "waiting" ? "From" : "Waiting on"}</span><span>Details</span><span>When</span><span className="r">{tab === "waiting" ? "Answer" : ""}</span></div>
              {rows.map((i) => row(i, tab === "sent"))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// Home's card: how much waits in your Inbox, by kind, and the way in. Nothing
// when it's empty.
const WORDS: Record<Kind, [string, string]> = {
  leave: ["leave request", "leave requests"], permission: ["permission", "permissions"], correction: ["correction", "corrections"],
  handover: ["hand-over", "hand-overs"], review: ["review", "reviews"], accept: ["task to accept", "tasks to accept"], reset: ["password reset", "password resets"],
};
export function InboxCard() {
  const { user } = useAuth();
  const { data } = useInbox(user?.id ?? "");
  if (!data || data.count === 0) return null;
  const parts = KINDS
    .map(({ k }) => [k, data.waiting.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${WORDS[k][n === 1 ? 0 : 1]}`);
  return (
    <Link to="/inbox" className="ib-card">
      <span className="ib-ic" aria-hidden="true">📥</span>
      <span className="ib-main">
        <span className="ib-title"><b>{data.count} waiting in your Inbox</b></span>
        <span className="ib-sub">{parts.join(" · ")}</span>
      </span>
      <span className="ib-go">Open Inbox →</span>
    </Link>
  );
}
