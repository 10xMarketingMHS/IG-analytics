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
// Data: lib/use-inbox.ts (GET /inbox).

type Kind = InboxItem["kind"];
const WAITING_GROUPS: [Kind, string][] = [
  ["leave", "Leave requests"], ["permission", "Permission requests"], ["correction", "Start-time corrections"],
  ["handover", "Hand-overs"], ["review", "Waiting for your review"], ["accept", "Tasks to accept"], ["reset", "Password resets"],
];
const SENT_GROUPS: [Kind, string][] = [
  ["leave", "Your leave"], ["permission", "Your permissions"], ["handover", "Your hand-overs"], ["review", "Your work in review"],
];
const ICON: Record<Kind, string> = { leave: "🌴", permission: "⏱️", correction: "🕘", handover: "🔁", review: "👀", accept: "📥", reset: "🔑" };
const day = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const n1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Face({ name, imageUrl, kind }: { name?: string | null; imageUrl?: string | null; kind: Kind }) {
  if (!name) return <span className="ib-ic" aria-hidden="true">{ICON[kind]}</span>;
  return (
    <span className="ib-face">
      <Avatar editor={{ id: name, name, designation: "", image_url: imageUrl ?? null, active: true } as Editor} />
    </span>
  );
}

export function InboxPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, refresh } = useInbox(user?.id ?? "");
  const [tab, setTab] = useState<"waiting" | "sent">("waiting");
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

  function row(i: InboxItem, sent: boolean): ReactNode {
    const off = busy === i.key;
    const btn = (label: string, onClick: () => void, cls = "") => (
      <button type="button" className={"ib-btn " + cls} disabled={off} onClick={onClick}>{label}</button>
    );
    let face: ReactNode = <Face kind={i.kind} />;
    let title: ReactNode = null;
    let sub: ReactNode = null;
    let acts: ReactNode = null;
    switch (i.kind) {
      case "leave": {
        const l = i.leave;
        face = sent ? <Face kind="leave" /> : <Face name={i.name} imageUrl={i.imageUrl} kind="leave" />;
        title = <>{sent ? "" : <b>{i.name} </b>}{leaveWords(l)}{l.shortNotice && <span className="ib-tag warn">short notice</span>}</>;
        const b = i.balance;
        const bal = !sent && l.kind === "cl" && b
          ? b.perYear ? ` · ${n1(Math.max(0, b.perYear - b.cl))} of ${n1(b.perYear)} CL left${b.unpaid ? `, ${n1(b.unpaid)} unpaid` : ""}` : " · no CL set (unpaid)"
          : "";
        sub = <>{l.note ? `“${l.note}” · ` : ""}asked {relTime(i.at)}{bal}{sent ? " · waiting on your lead" : ""}</>;
        acts = sent
          ? btn("Cancel", () => act(i.key, () => cancelMyLeave(l.id), "Leave cancelled."), "ghost")
          : <>{btn("Decline", () => act(i.key, () => leaveAction(i.editorId!, l.id, "decline"), "Leave declined."), "ghost")}
             {btn("Approve", () => act(i.key, () => leaveAction(i.editorId!, l.id, "approve"), `${i.name?.split(" ")[0]}'s leave approved.`), "good")}</>;
        break;
      }
      case "permission":
        face = sent ? <Face kind="permission" /> : <Face name={i.name} imageUrl={i.imageUrl} kind="permission" />;
        title = <>{sent ? "" : <b>{i.name} </b>}{i.part === "morning" ? "Morning permission (come in late)" : "Evening permission (leave early)"} · {day(i.date)}</>;
        sub = <>{i.note ? `“${i.note}” · ` : ""}asked {relTime(i.at)}{sent ? " · waiting on your lead" : ""}</>;
        acts = sent ? null
          : <>{btn("Decline", () => act(i.key, () => attendanceAction(i.editorId!, "permission", { id: i.id, approve: false }), "Permission declined."), "ghost")}
             {btn("Approve", () => act(i.key, () => attendanceAction(i.editorId!, "permission", { id: i.id, approve: true }), "Permission approved."), "good")}</>;
        break;
      case "correction":
        face = <Face name={i.name} imageUrl={i.imageUrl} kind="correction" />;
        title = <><b>{i.name} </b>asks to start at {clockTime(i.correctionAt)}{i.date !== new Date().toLocaleDateString("en-CA") ? ` on ${day(i.date)}` : ""}</>;
        sub = <>{i.checkInAt ? `Opened Pulse at ${clockTime(i.checkInAt)}` : "Not opened yet"}{i.note ? ` · “${i.note}”` : ""} · {relTime(i.at)}</>;
        acts = <>{btn("Decline", () => act(i.key, () => attendanceAction(i.editorId, "correction", { approve: false }), "Correction declined."), "ghost")}
          {btn("Approve", () => act(i.key, () => attendanceAction(i.editorId, "correction", { approve: true }), "Start time corrected."), "good")}</>;
        break;
      case "handover": {
        const h = i.handover;
        face = <Face name={sent ? h.toName : h.fromName} imageUrl={sent ? h.toImage : h.fromImage} kind="handover" />;
        title = <>{h.taskRef && <span className="ib-ref">{h.taskRef}</span>}{h.taskTitle}</>;
        sub = sent
          ? <>Offered to {h.toName ?? "a teammate"} {relTime(h.createdAt)}{h.level > 0 && h.reachedLabel ? ` · now with ${h.reachedLabel}` : ""}</>
          : h.mine === "to"
            ? <>From {h.fromName ?? "a teammate"}{h.note ? `: “${h.note}”` : ""} · {relTime(h.createdAt)}</>
            : <>{h.toName ?? "A teammate"} hasn't accepted it from {h.fromName ?? "its owner"} · open it to move it on</>;
        acts = sent
          ? btn("Take back", () => act(i.key, () => handoverPost(`/handovers/${h.id}/cancel`), "Hand-over taken back."), "ghost")
          : h.mine === "to"
            ? <>{btn("Decline", () => act(i.key, () => handoverPost(`/handovers/${h.id}/decline`), `Declined. It stays with ${h.fromName ?? "its owner"}.`), "ghost")}
               {btn("Accept", () => act(i.key, () => handoverPost(`/handovers/${h.id}/accept`), "It's yours now."), "good")}</>
            : btn("Open", () => openTask(h.taskId));
        break;
      }
      case "review":
        face = <Face name={sent ? null : i.name} imageUrl={i.imageUrl} kind="review" />;
        title = <>{i.ref && <span className="ib-ref">{i.ref}</span>}{i.title}</>;
        sub = sent ? <>Sent for review {relTime(i.at)}{i.reviewBy ? ` · waiting for ${i.reviewBy}` : ""}</> : <>From {i.name ?? "a teammate"} · waiting {relTime(i.at).replace(" ago", "")}</>;
        acts = btn("Open", () => openTask(i.taskId), sent ? "ghost" : "pri");
        break;
      case "accept":
        title = <>{i.ref && <span className="ib-ref">{i.ref}</span>}{i.title}</>;
        sub = <>From {i.name ?? "your lead"}{i.due ? ` · due ${day(i.due)}` : ""} · {relTime(i.at)}</>;
        acts = btn("Open", () => openTask(i.taskId), "pri");
        break;
      case "reset":
        face = <Face name={i.name} kind="reset" />;
        title = <><b>{i.name}</b> forgot their password</>;
        sub = <>Asked {relTime(i.at)} · set a new one on Team › Roster</>;
        acts = btn("Open Roster", () => navigate("/my-team?tab=roster"), "pri");
        break;
    }
    return (
      <li key={i.key} className="ib-row">
        {face}
        <span className="ib-main"><span className="ib-title">{title}</span><span className="ib-sub">{sub}</span></span>
        {acts && <span className="ib-acts">{acts}</span>}
      </li>
    );
  }

  const list = tab === "waiting" ? data?.waiting ?? [] : data?.sent ?? [];
  const groups = (tab === "waiting" ? WAITING_GROUPS : SENT_GROUPS)
    .map(([k, label]) => ({ k, label, items: list.filter((i) => i.kind === k) }))
    .filter((g) => g.items.length > 0);
  return (
    <section className="screen ib">
      <div className="ib-tabs seg" role="tablist" aria-label="Inbox">
        <button type="button" role="tab" aria-selected={tab === "waiting"} className={"seg-btn" + (tab === "waiting" ? " on" : "")} onClick={() => setTab("waiting")}>
          Waiting on you{data ? <span className="ib-n">{data.waiting.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "sent"} className={"seg-btn" + (tab === "sent" ? " on" : "")} onClick={() => setTab("sent")}>
          Sent by you{data ? <span className="ib-n soft">{data.sent.length}</span> : null}
        </button>
      </div>
      {!data ? (
        <div className="card pad ib-empty">Loading your Inbox…</div>
      ) : groups.length === 0 ? (
        <div className="card pad ib-empty">
          {tab === "waiting" ? "Nothing is waiting on you. Requests, hand-overs and reviews land here." : "Nothing you sent is waiting on anyone."}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.k} className="card ib-group">
            <div className="ib-ghead"><span aria-hidden="true">{ICON[g.k]}</span><b>{g.label}</b><span className="ib-n soft">{g.items.length}</span></div>
            <ul className="ib-list">{g.items.map((i) => row(i, tab === "sent"))}</ul>
          </div>
        ))
      )}
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
  const parts = WAITING_GROUPS
    .map(([k]) => [k, data.waiting.filter((i) => i.kind === k).length] as const)
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
