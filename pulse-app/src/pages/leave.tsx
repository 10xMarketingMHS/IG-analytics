import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { askPermission } from "@/lib/use-attendance";
import { Icon } from "@/components/icon";
import { Avatar } from "@/lib/editor-visuals";
import { useOrg } from "@/lib/use-org";
import { useAuth } from "@/lib/auth-context";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { homeRoleOf, seesTeamAttendance } from "@/lib/home-role";
import { TeamAttendance } from "@/pages/team-attendance";
import {
  HALF_WORDS, addDays, askLeave, cancelLeave, cancelPermission, dayWord, decideByWords, decideLeave, decidePermission, detailOf, fmtDates, fmtDay, n1,
  previewLeave, saveLeaveRules, savePermissionsPerMonth, setAllowance, startCounting, topUp, useLeaveData,
  type LeaveHalf, type LeaveMine, type LeavePreview, type LeaveRequest, type LeaveTeam, type LeaveType, type PermissionMine,
  type PermissionPart, type PermissionRow,
} from "@/lib/use-leave";
import type { Editor } from "@/lib/types";
import "./leave.css";

// Leave — casual leave (CL) and sick leave (SL), as in the prototype "Pulse
// Leave.dc.html": Ask for leave (everyone), Approvals and Allowances & rules
// (managers and admins). One screen, three ways in:
//   mode "team" — My Team › Leave: Approvals and Allowances & rules;
//   mode "all"  — the side panel (LeavePanel: the top bar's Attendance, and
//                 Ask for leave on the Start your day card) and /leave: the
//                 attendance month first (the team's for leads, managers and
//                 admins; your own row for everyone else), then the leave tabs;
//   mode "mine" — just your balance, requests and the form (no tabs).
// Rules: server/src/leave-math.js.

type Tab = "attendance" | "apply" | "permission" | "approve" | "settings";
const ST: Record<LeaveRequest["status"], { t: string; cls: string }> = {
  pending: { t: "Waiting", cls: "warn" }, approved: { t: "Approved", cls: "good" },
  declined: { t: "Declined", cls: "bad" }, cancelled: { t: "Cancelled", cls: "mute" },
};
const fail = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : fallback);
const pct = (x: number, total: number) => `${total ? Math.min(100, (x / total) * 100) : 0}%`;

function Face({ name, imageUrl, size = 34 }: { name: string; imageUrl?: string | null; size?: number }) {
  return (
    <span className="lv-face" style={{ width: size, height: size }}>
      <Avatar editor={{ id: name, name, designation: "", image_url: imageUrl ?? null, active: true } as Editor} />
    </span>
  );
}
const TypeChip = ({ type }: { type: LeaveType }) => <span className={"lv-type " + type.toLowerCase()}>{type}</span>;
const Status = ({ s }: { s: LeaveRequest["status"] }) => <span className={"lv-st " + ST[s].cls}>{ST[s].t}</span>;
// Saves that end on the last value asked for: fast clicks add up from it, one
// save at a time per key, so an older save never lands after a newer one.
function useLastSave<T>(save: (key: string, v: T) => Promise<unknown>, undo: (key: string, e: unknown) => void) {
  const want = useRef(new Map<string, T>());
  const busy = useRef(new Set<string>());
  return {
    latest: (key: string) => want.current.get(key),
    saving: (key: string) => busy.current.has(key),
    forget: (key: string) => { want.current.delete(key); },
    push: async (key: string, v: T) => {
      want.current.set(key, v);
      if (busy.current.has(key)) return;
      busy.current.add(key);
      try {
        let sent = v;
        await save(key, sent);
        while (want.current.get(key) !== sent) { sent = want.current.get(key)!; await save(key, sent); }
      } catch (e) {
        want.current.delete(key);
        undo(key, e);
      } finally {
        busy.current.delete(key);
      }
    },
  };
}

function Stepper({ value, onDec, onInc, disabled, wide }: { value: string; onDec: () => void; onInc: () => void; disabled?: boolean; wide?: boolean }) {
  return (
    <span className={"lv-step" + (disabled ? " off" : "")}>
      <button type="button" onClick={onDec} disabled={disabled} aria-label="Less"><Icon name="remove" size={17} /></button>
      <b className={wide ? "wide" : ""}>{value}</b>
      <button type="button" onClick={onInc} disabled={disabled} aria-label="More"><Icon name="add" size={17} /></button>
    </span>
  );
}

export function LeaveScreen({ startTab = "apply", onTab, mode = "all" }: { startTab?: Tab; onTab?: (t: Tab) => void; mode?: "all" | "team" | "mine" }) {
  const navigate = useNavigate();
  const mine = useLeaveData<LeaveMine>("/leave/mine");
  // the attendance month: the whole team for whoever sees it (as on My Team),
  // otherwise your own row
  const { user } = useAuth();
  const { isAdmin } = useWorkspaces();
  const { editors } = useEditors();
  const { org } = useOrg();
  const myEd = (editors ?? []).find((e) => e.id === user?.editorId) ?? null;
  const seesTeam = isAdmin || (homeRoleOf(myEd?.designation, false) !== "editor" && seesTeamAttendance(myEd?.designation, false, org?.attendance?.teamView));
  const canApprove = !!mine.data?.canApprove;
  const team = useLeaveData<LeaveTeam>(canApprove && mode !== "mine" ? "/leave/team" : null);
  const [tab, setTabState] = useState<Tab>(startTab);
  useEffect(() => setTabState(startTab), [startTab]);
  const setTab = (t: Tab) => { setTabState(t); onTab?.(t); };
  const shown: Tab = mode === "mine" ? "apply"
    : mode === "team" ? (tab === "settings" ? "settings" : "approve")
    : tab === "attendance" || tab === "permission" ? tab
    : !canApprove ? "apply" : tab;
  // where the allowances are set (from the form, before counting starts)
  const goSettings = !canApprove ? null : mode === "all" ? () => setTab("settings") : () => navigate("/my-team?tab=leave&view=settings");
  const waiting = team.data ? team.data.pending.filter((r) => r.editorId !== team.data!.me).length : 0;
  const today = mine.data?.today;
  const tabs: { id: Tab; label: string; icon: string; count?: number }[] = mode === "mine" ? [] : [
    ...(mode === "all" ? [
      { id: "attendance" as Tab, label: seesTeam ? "Team attendance" : "My attendance", icon: "how_to_reg" },
      { id: "apply" as Tab, label: "Ask for leave", icon: "edit_calendar" },
      { id: "permission" as Tab, label: "Permission", icon: "more_time" },
    ] : []),
    ...(canApprove ? [
      { id: "approve" as Tab, label: "Approvals", icon: "fact_check", count: waiting },
      { id: "settings" as Tab, label: "Allowances & rules", icon: "tune" },
    ] : []),
  ];
  if (mode === "team" && mine.data && !canApprove) {
    return <div className="lv"><div className="lv-card lv-empty">Only managers answer leave and set the allowances.</div></div>;
  }
  return (
    <div className={"lv" + (mode === "mine" ? " lv-mine" : "")}>
      {mode !== "mine" && <header className="lv-head">
        <div className="lv-title">
          <span className="lv-tile"><Icon name="event_available" size={22} /></span>
          <div>
            <b>{mode === "all" ? "Attendance" : "Leave"}</b>
            <span>
              {mode === "team" ? "Approvals, balances and allowances"
                : mode === "all" ? `${seesTeam ? "The team's" : "Your"} attendance, casual leave (CL) and sick leave (SL)`
                : "Casual leave (CL) and sick leave (SL)"}
              {today ? ` · today is ${fmtDay(today)} ${today.slice(0, 4)}` : ""}
            </span>
          </div>
        </div>
        {tabs.length > 1 && (
          <div className="lv-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={shown === t.id} className={shown === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={17} />{t.label}
                {t.count ? <span className="lv-count">{t.count}</span> : null}
              </button>
            ))}
          </div>
        )}
      </header>}
      {shown === "attendance" ? <TeamAttendance editors={editors} self={!seesTeam} />
        : shown === "permission" ? <PermissionTab />
        : mine.error ? <div className="lv-card lv-empty">{mine.error}</div>
        : !mine.data ? <div className="lv-card lv-empty">Loading leave…</div>
        : !mine.data.ready ? <div className="lv-card lv-empty">Leave needs a database update first — ask whoever runs the database to apply 20261030120000_leave.</div>
        : shown === "apply" ? <AskTab mine={mine.data} goSettings={goSettings} />
        : !team.data ? <div className="lv-card lv-empty">{team.error ?? "Loading…"}</div>
        : shown === "approve" ? <ApproveTab team={team.data} />
        : <SettingsTab team={team.data} />}
    </div>
  );
}

// ---- Ask for leave ----

function AskTab({ mine, goSettings }: { mine: LeaveMine; goSettings: (() => void) | null }) {
  const { today, rules } = mine;
  const [type, setType] = useState<LeaveType>("CL");
  const [from, setFrom] = useState(() => addDays(today, rules.noticeDays));
  const [to, setTo] = useState(() => addDays(today, rules.noticeDays));
  const [half, setHalf] = useState<LeaveHalf>("full");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const oneDay = !!from && from === to;
  const useHalf: LeaveHalf = oneDay ? half : "full";

  // the summary follows the form (the server works it out, with the calendar)
  useEffect(() => {
    if (!mine.counting || !mine.linked) return;
    let stop = false;
    const id = window.setTimeout(() => {
      previewLeave({ type, from, to, half: useHalf })
        .then((p) => { if (!stop) setPreview(p); })
        .catch(() => { if (!stop) setPreview({ error: "Couldn't check those days." }); });
    }, 200);
    return () => { stop = true; window.clearTimeout(id); };
  }, [type, from, to, useHalf, mine.counting, mine.linked, mine.requests]);

  async function send() {
    setBusy(true);
    try {
      await askLeave({ type, from, to, half: useHalf, reason: reason.trim() || undefined });
      toast.success(`${type} request sent to managers`);
      setReason("");
    } catch (e) {
      fail(e, "Couldn't send that request.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(r: LeaveRequest) {
    try {
      await cancelLeave(r.id);
      toast.success("Request cancelled · balance given back");
    } catch (e) { fail(e, "Couldn't cancel it."); }
  }

  const summary: { label: string; value: string; tone?: "warn" | "bad" | "good" }[] = [];
  if (preview && preview.error === undefined) {
    const p = preview;
    if (type === "CL") {
      summary.push(p.short
        ? { label: "Notice", value: `${p.notice} working day${p.notice === 1 ? "" : "s"}: short. CL needs ${rules.noticeDays}. Allowed, but −${n1(rules.shortNoticePts)} discipline pts.`, tone: "warn" }
        : { label: "Notice", value: `${p.notice} working days ahead · OK`, tone: "good" });
    } else {
      summary.push({ label: "Notice", value: "Not needed for sick leave" });
    }
    summary.push({ label: "Leave days", value: `${dayWord(p.days)}${from !== to ? " (off days skipped)" : ""}` });
    summary.push({ label: `From ${type} balance`, value: `${n1(p.paid)} · ${n1(Math.max(0, p.left - p.paid))} of ${n1(p.total)} left after` });
    if (p.unpaid) summary.push({ label: "Unpaid", value: `${dayWord(p.unpaid)}: no ${type} left. Goal still shrinks; −${n1(p.unpaid * rules.unpaidPts)} pts (${n1(rules.unpaidPts)} a day).`, tone: "bad" });
    summary.push({ label: "Discipline points", value: p.pts ? `−${n1(p.pts)}` : "No cut", tone: p.pts ? "bad" : "good" });
  }
  const error = preview?.error ?? null;
  const b = mine.balance;
  const mineList = [...mine.requests].sort((x, y) => y.from.localeCompare(x.from));

  return (
    <section className="lv-grid2">
      <div className="lv-card lv-form">
        <b className="lv-h">Ask for leave</b>
        {!mine.linked ? (
          <p className="lv-faint">Your login isn't linked to a team member, so there's no leave to ask for.</p>
        ) : !mine.counting ? (
          <p className="lv-faint">
            Leave opens once a manager sets this year's allowances and starts counting.
            {goSettings && <> <button type="button" className="lv-link" onClick={goSettings}>Set them on Allowances & rules</button></>}
          </p>
        ) : (
          <>
            <div className="lv-types">
              {([["CL", "Casual leave", "beach_access", `${rules.noticeDays} working days’ notice`], ["SL", "Sick leave", "medication", "Any time"]] as const).map(([k, label, icon, sub]) => (
                <button key={k} type="button" className={"lv-typeopt" + (type === k ? " on" : "")} onClick={() => setType(k)} aria-pressed={type === k}>
                  <span className="lv-typeopt-l"><Icon name={icon} size={18} />{label}</span>
                  <span className="lv-typeopt-s">{sub}</span>
                </button>
              ))}
            </div>
            <div className="lv-dates">
              <label>From<input type="date" value={from} onChange={(e) => { const v = e.target.value; setFrom(v); if (!to || to < v) setTo(v); }} /></label>
              <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
            {oneDay && (
              <div className="lv-seg" role="radiogroup" aria-label="Which part of the day">
                {(["full", "first", "second"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={half === k} className={half === k ? "on" : ""} onClick={() => setHalf(k)}>{HALF_WORDS[k]}</button>
                ))}
              </div>
            )}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} placeholder="Reason for the manager (optional)" />
            {error ? (
              <div className="lv-error"><Icon name="error" size={17} />{error}</div>
            ) : summary.length > 0 && (
              <div className="lv-summary">
                {summary.map((s) => (
                  <div key={s.label} className={s.tone ? "t-" + s.tone : ""}><span>{s.label}</span><b>{s.value}</b></div>
                ))}
              </div>
            )}
            <div className="lv-send">
              <button type="button" className="lv-btn pri" onClick={send} disabled={busy || !preview || !!error}><Icon name="send" size={18} />{busy ? "Sending…" : "Send to managers"}</button>
              <span className="lv-faint">Any manager can approve. Waiting requests hold your balance.</span>
            </div>
          </>
        )}
      </div>

      <div className="lv-col">
        {b && (
          <div className="lv-card">
            <div className="lv-hrow"><b className="lv-h">{mine.name ? `${mine.name.split(" ")[0]}’s balance` : "Your balance"}</b><span className="lv-faint">{mine.year} · resets 1 Jan</span></div>
            {(["CL", "SL"] as const).map((t) => {
              const x = b[t];
              return (
                <div key={t} className="lv-bal">
                  <div className="lv-bal-top">
                    <b>{t === "CL" ? "Casual leave" : "Sick leave"}</b>
                    <span><b className={x.left === 0 ? "t-bad" : ""}>{n1(x.left)}</b> of {n1(x.total)} left</span>
                  </div>
                  <div className={"lv-bar " + t.toLowerCase()}><span style={{ width: pct(x.taken, x.total) }} /><span className="hold" style={{ width: pct(x.waiting, x.total) }} /></div>
                  <span className="lv-faint">
                    {x.topups ? `${n1(x.start)} + ${n1(x.topups)} top-up · ` : ""}{n1(x.taken)} taken{x.waiting ? ` · ${n1(x.waiting)} waiting` : ""}{x.left === 0 ? " · more days become unpaid" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="lv-card lv-list">
          <b className="lv-h">{mine.name ? `${mine.name.split(" ")[0]}’s requests` : "Your requests"}</b>
          {mineList.length === 0 && <span className="lv-faint">No leave this year yet.</span>}
          {mineList.map((r) => (
            <div key={r.id} className="lv-req">
              <TypeChip type={r.type} />
              <span className="lv-req-main"><b>{fmtDates(r)}</b><span>{detailOf(r)}{r.status === "pending" && r.decideBy ? <em className="lv-due"> · {decideByWords(r, "mine")}</em> : null}</span></span>
              <Status s={r.status} />
              {(r.status === "pending" || (r.status === "approved" && r.from > today)) && (
                <button type="button" className="lv-ghost" title="Cancel this request" onClick={() => cancel(r)}>Cancel</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- Permission ----

const PERM_ST: Record<PermissionRow["status"], { t: string; cls: string }> = {
  requested: { t: "Waiting", cls: "warn" }, approved: { t: "Approved", cls: "good" }, used: { t: "Used", cls: "mute" }, declined: { t: "Declined", cls: "bad" },
};
// "11:30" → "11:30 AM"
const hm12 = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };

// Ask for a permission (morning: come in late; evening: leave early — up to 2
// hours), what's left this month, and your permissions. A lead approves it;
// a late morning without asking uses one on the day while any are left.
function PermissionTab() {
  const { data } = useLeaveData<PermissionMine>("/attendance/permissions/mine");
  const [date, setDate] = useState("");
  const [part, setPart] = useState<PermissionPart>("morning");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data?.today && !date) setDate(data.today); }, [data, date]);
  if (!data) return <div className="lv-card lv-empty">Loading…</div>;
  if (!data.ready) return <div className="lv-card lv-empty">Permissions need a database update first.</div>;
  const monthName = new Date(`${data.today}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const used = data.perMonth - data.left;
  // what's left is this month's: another month is checked when it's sent
  const thisMonth = date.slice(0, 7) === data.today.slice(0, 7);
  const none = thisMonth && data.left === 0;
  async function send() {
    setBusy(true);
    try {
      await askPermission(date, part, note.trim() || undefined);
      toast.success(`Asked for a ${part} permission on ${fmtDay(date)}. Your lead approves it.`);
      setNote("");
    } catch (e) {
      fail(e, "Couldn't send that request.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(p: PermissionRow) {
    try { await cancelPermission(p.id); toast.success("Permission cancelled · it counts again"); } catch (e) { fail(e, "Couldn't cancel it."); }
  }
  return (
    <section className="lv-grid2">
      <div className="lv-card lv-form">
        <b className="lv-h">Ask for a permission</b>
        {!data.linked ? (
          <p className="lv-faint">Your login isn't linked to a team member, so there's no permission to ask for.</p>
        ) : (
          <>
            <div className="lv-types">
              {([["morning", "Morning", "wb_twilight", `Come in late · up to 2 hours${data.halfDayAt ? ` (till ${hm12(data.halfDayAt)})` : ""}`], ["evening", "Evening", "nights_stay", "Leave early · up to 2 hours"]] as const).map(([k, label, icon, sub]) => (
                <button key={k} type="button" className={"lv-typeopt" + (part === k ? " on" : "")} onClick={() => setPart(k)} aria-pressed={part === k}>
                  <span className="lv-typeopt-l"><Icon name={icon} size={18} />{label}</span>
                  <span className="lv-typeopt-s">{sub}</span>
                </button>
              ))}
            </div>
            <div className="lv-dates">
              <label>Day<input type="date" value={date} min={data.today} max={addDays(data.today, 60)} onChange={(e) => setDate(e.target.value)} /></label>
            </div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} placeholder="Reason for your lead (optional)" />
            {none ? (
              <div className="lv-error"><Icon name="error" size={17} />No permissions left this month. A day next month can still be asked for.</div>
            ) : date && (
              <div className="lv-summary">
                <div><span>When</span><b>{part === "morning" ? "Come in late" : "Leave early"} on {fmtDay(date)}, up to 2 hours</b></div>
                <div><span>{thisMonth ? "This month" : "That month"}</span><b>{thisMonth ? `${data.left} of ${data.perMonth} left · ${Math.max(0, data.left - 1)} after this` : `Up to ${data.perMonth} a month`}</b></div>
              </div>
            )}
            <div className="lv-send">
              <button type="button" className="lv-btn pri" onClick={send} disabled={busy || !date || none}><Icon name="send" size={18} />{busy ? "Sending…" : "Send to my lead"}</button>
              <span className="lv-faint">Your lead approves it. Late without asking? One is used on the day while any are left.</span>
            </div>
          </>
        )}
      </div>
      <div className="lv-col">
        <div className="lv-card">
          <div className="lv-hrow"><b className="lv-h">Permissions · {monthName}</b><span className="lv-faint">resets each month</span></div>
          <div className="lv-bal">
            <div className="lv-bal-top">
              <b>This month</b>
              <span><b className={data.left === 0 ? "t-bad" : ""}>{data.left}</b> of {data.perMonth} left</span>
            </div>
            <div className="lv-bar"><span style={{ width: pct(used, data.perMonth) }} /></div>
            <span className="lv-faint">Up to 2 hours each · morning (come in late) or evening (leave early)</span>
          </div>
        </div>
        <div className="lv-card lv-list">
          <b className="lv-h">Your permissions</b>
          {data.mine.length === 0 && <span className="lv-faint">None this month yet.</span>}
          {data.mine.map((p) => (
            <div key={p.id} className="lv-req">
              <span className={"lv-type " + (p.part === "morning" ? "cl" : "sl")}>{p.part === "morning" ? "AM" : "PM"}</span>
              <span className="lv-req-main">
                <b>{fmtDay(p.date)}</b>
                <span>{p.part === "morning" ? "Come in late" : "Leave early"}{p.emergency ? " · used on the day" : ""}{p.note ? ` · “${p.note}”` : ""}</span>
              </span>
              <span className={"lv-st " + PERM_ST[p.status].cls}>{PERM_ST[p.status].t}</span>
              {(p.status === "requested" || (p.status === "approved" && p.date > data.today)) && (
                <button type="button" className="lv-ghost" onClick={() => cancel(p)}>Cancel</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- Approvals ----

function ApproveTab({ team }: { team: LeaveTeam }) {
  const [busy, setBusy] = useState<string | null>(null);
  const today = team.today;
  async function decide(r: LeaveRequest, approve: boolean) {
    setBusy(r.id);
    try {
      await decideLeave(r.id, approve);
      toast.success(`${r.name}’s ${r.type} ${approve ? "approved" : "declined · balance given back"}`);
    } catch (e) {
      fail(e, "Couldn't answer that request.");
    } finally {
      setBusy(null);
    }
  }
  const asked = (r: { createdAt: string }) => {
    const day = new Date(new Date(r.createdAt).getTime() + 330 * 60_000).toISOString().slice(0, 10);
    return day === today ? "today" : fmtDay(day);
  };
  async function answerPermission(p: { id: string; editorId: string; name: string; part: PermissionPart }, approve: boolean) {
    setBusy(p.id);
    try {
      await decidePermission(p.editorId, p.id, approve);
      toast.success(`${p.name}’s ${p.part} permission ${approve ? "approved" : "declined"}`);
    } catch (e) {
      fail(e, "Couldn't answer that request.");
    } finally {
      setBusy(null);
    }
  }
  const permsWaiting = team.permissions?.pending ?? [];
  return (
    <section className="lv-stack">
      <div className="lv-card lv-list">
        <div className="lv-hrow"><b className="lv-h">Waiting for a manager</b><span className="lv-faint">Approved leave shrinks that person’s goal for the month</span></div>
        {team.pending.length === 0 && <span className="lv-faint lv-pad">Nothing waiting.</span>}
        {team.pending.map((r) => {
          const flags: { t: string; icon: string; cls: string }[] = [];
          if (r.short) flags.push({ t: `Short notice · −${n1(r.shortPts ?? r.pts - r.unpaid * team.rules.unpaidPts)} pts`, icon: "schedule", cls: "warn" });
          if (r.unpaid) flags.push({ t: `${dayWord(r.unpaid)} unpaid`, icon: "money_off", cls: "bad" });
          if (r.from < today) flags.push({ t: "After the day", icon: "history", cls: "rev" });
          // last month's: decide it before Management Performance closes the month
          const due = decideByWords(r, "manager");
          if (due) flags.unshift({ t: due, icon: "event_busy", cls: r.decideBy === "closed" ? "bad" : "warn" });
          if (!flags.length) flags.push({ t: "Within the rules", icon: "check", cls: "good" });
          const own = r.editorId === team.me;
          return (
            <div key={r.id} className="lv-pend">
              <Face name={r.name ?? "?"} imageUrl={r.imageUrl} />
              <span className="lv-pend-main">
                <span className="lv-pend-top"><b>{r.name}</b><TypeChip type={r.type} /><span>{fmtDates(r)} · {r.half !== "full" ? HALF_WORDS[r.half] : dayWord(r.days)}</span></span>
                <span className="lv-faint">{r.reason ? `“${r.reason}” · ` : ""}asked {asked(r)}{r.type === "CL" ? ` · ${r.notice ?? 0} working day${r.notice === 1 ? "" : "s"} notice` : ""}</span>
              </span>
              <span className="lv-flags">{flags.map((f) => <span key={f.t} className={"lv-flag " + f.cls}><Icon name={f.icon} size={14} />{f.t}</span>)}</span>
              <span className="lv-acts">
                {own ? <span className="lv-faint">Yours: another manager decides</span> : (
                  <>
                    <button type="button" className="lv-btn line" disabled={busy === r.id} onClick={() => decide(r, false)}>Decline</button>
                    <button type="button" className="lv-btn pri sm" disabled={busy === r.id || r.decideBy === "closed"} title={r.decideBy === "closed" ? "Its month is closed in Management Performance" : undefined} onClick={() => decide(r, true)}><Icon name="check" size={16} />Approve</button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {permsWaiting.length > 0 && (
        <div className="lv-card lv-list">
          <div className="lv-hrow"><b className="lv-h">Permissions waiting</b><span className="lv-faint">Up to 2 hours: come in late, or leave early</span></div>
          {permsWaiting.map((p) => (
            <div key={p.id} className="lv-pend">
              <Face name={p.name} imageUrl={p.imageUrl} />
              <span className="lv-pend-main">
                <span className="lv-pend-top"><b>{p.name}</b><span className={"lv-type " + (p.part === "morning" ? "cl" : "sl")}>{p.part === "morning" ? "AM" : "PM"}</span><span>{fmtDay(p.date)} · {p.part === "morning" ? "come in late" : "leave early"}</span></span>
                <span className="lv-faint">{p.note ? `“${p.note}” · ` : ""}asked {asked(p)}</span>
              </span>
              <span className="lv-acts">
                <button type="button" className="lv-btn line" disabled={busy === p.id} onClick={() => answerPermission(p, false)}>Decline</button>
                <button type="button" className="lv-btn pri sm" disabled={busy === p.id} onClick={() => answerPermission(p, true)}><Icon name="check" size={16} />Approve</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="lv-card lv-scroll">
        <div className="lv-hrow"><b className="lv-h">Team balance · {team.year}</b><span className="lv-faint">Used includes waiting requests · permissions this month</span></div>
        <div className="lv-tbl bal">
          <span className="lv-th">Member</span><span className="lv-th">Casual</span><span className="lv-th">Sick</span><span className="lv-th r">Permissions</span><span className="lv-th r">Unpaid</span><span className="lv-th r">Pts cut</span>
          {team.people.map((p) => {
            const b = p.balance;
            if (!b) return null;
            const clU = b.CL.taken + b.CL.waiting, slU = b.SL.taken + b.SL.waiting, unpaid = b.unpaid + b.unpaidWaiting;
            return (
              <div key={p.id} className="lv-tr">
                <span className="lv-who"><Face name={p.name} imageUrl={p.imageUrl} size={26} /><b>{p.name}</b></span>
                <span className="lv-used"><span><b>{n1(clU)}</b> / {n1(b.CL.total)}</span><span className="lv-bar sm cl"><span style={{ width: pct(clU, b.CL.total) }} /></span></span>
                <span className="lv-used"><span><b>{n1(slU)}</b> / {n1(b.SL.total)}</span><span className="lv-bar sm sl"><span style={{ width: pct(slU, b.SL.total) }} /></span></span>
                <span className={"lv-num" + (team.permissions && (p.permissionsUsed ?? 0) >= team.permissions.perMonth ? " t-warn" : "")}>{team.permissions ? `${p.permissionsUsed ?? 0} / ${team.permissions.perMonth}` : "–"}</span>
                <span className={"lv-num" + (unpaid ? " t-bad" : " t-mute")}>{unpaid ? n1(unpaid) : "–"}</span>
                <span className={"lv-num" + (b.pts ? " t-bad" : " t-mute")}>{b.pts ? `−${n1(b.pts)}` : "0"}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="lv-card lv-list">
        <b className="lv-h">Decided</b>
        {team.decided.length === 0 && <span className="lv-faint">Nothing decided yet this year.</span>}
        {team.decided.slice(0, 8).map((r) => (
          <div key={r.id} className="lv-req">
            <TypeChip type={r.type} />
            <span className="lv-req-main one"><b>{r.name}</b><span> · {fmtDates(r)} · {detailOf(r)}{r.decidedByName && r.status !== "cancelled" ? ` · by ${r.decidedByName}` : ""}</span></span>
            <Status s={r.status} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Allowances & rules ----

function SettingsTab({ team }: { team: LeaveTeam }) {
  const { org, refetch: refetchOrg } = useOrg();
  const [rules, setRules] = useState(team.rules);
  const rulesSave = useLastSave<LeaveTeam["rules"]>((_, v) => saveLeaveRules(v), (_, e) => { setRules(team.rules); fail(e, "Couldn't save the rules."); });
  // the server's rules, unless a change is still being saved
  useEffect(() => {
    if (rulesSave.saving("rules")) return;
    rulesSave.forget("rules");
    setRules(team.rules);
  }, [team.rules]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editStart, setEditStart] = useState(false);
  // one person's starting days, edited on their row (a Super Admin)
  const [editRow, setEditRow] = useState<string | null>(null);
  // that row's numbers while they're changed, saved once with Save: a manager
  // sets a new joiner's first allowance once (after that it's the Super Admin's)
  const [rowDraft, setRowDraft] = useState<{ cl: number; sl: number }>({ cl: 0, sl: 0 });
  const openRow = (id: string) => { setEditRow(id); setRowDraft(startOf(id)); setTopFor(null); };
  const stepDraft = (k: "cl" | "sl", delta: number) => setRowDraft((d) => ({ ...d, [k]: Math.max(0, Math.min(30, d[k] + delta)) }));
  async function saveRow(id: string) {
    setBusy(true);
    try {
      await setAllowance(id, team.year, rowDraft.cl, rowDraft.sl);
      setStart((s) => ({ ...s, [id]: rowDraft }));
      setEditRow(null);
      toast.success(team.canEditRules ? "Starting allowance saved" : "Starting allowance saved. Only the Super Admin can change it now.");
    } catch (e) { fail(e, "Couldn't save that."); } finally { setBusy(false); }
  }
  const [topFor, setTopFor] = useState<string | null>(null);
  const [topType, setTopType] = useState<LeaveType>("CL");
  const [topDays, setTopDays] = useState(1);
  const [topNote, setTopNote] = useState("");
  const [busy, setBusy] = useState(false);
  // starting numbers as typed, before the server answers
  const [start, setStart] = useState<Record<string, { cl: number; sl: number }>>({});
  const startOf = (id: string) => {
    const p = team.people.find((x) => x.id === id);
    return start[id] ?? { cl: p?.balance?.CL.start ?? 0, sl: p?.balance?.SL.start ?? 0 };
  };
  const setup = !team.counting || editStart;
  const satWorking = org ? !org.calendar.satOff : true;

  function changeRule(key: keyof typeof rules, delta: number, min: number, max: number) {
    const cur = rulesSave.latest("rules") ?? rules;
    const next = { ...cur, [key]: Math.max(min, Math.min(max, Math.round((cur[key] + delta) * 2) / 2)) };
    setRules(next);
    void rulesSave.push("rules", next);
  }
  const startSave = useLastSave<{ cl: number; sl: number }>(
    (id, v) => setAllowance(id, team.year, v.cl, v.sl),
    (id, e) => { setStart((s) => { const n = { ...s }; delete n[id]; return n; }); fail(e, "Couldn't save that."); },
  );
  function changeStart(id: string, key: "cl" | "sl", delta: number) {
    const cur = startSave.latest(id) ?? startOf(id);
    const next = { ...cur, [key]: Math.max(0, Math.min(30, cur[key] + delta)) };
    setStart((s) => ({ ...s, [id]: next }));
    void startSave.push(id, next);
  }
  async function begin() {
    setBusy(true);
    try { await startCounting(); toast.success("Counting started · use Top up to add days"); } catch (e) { fail(e, "Couldn't start counting."); } finally { setBusy(false); }
  }
  async function saveTop() {
    if (!topFor || !topNote.trim()) return;
    setBusy(true);
    try {
      await topUp({ editorId: topFor, type: topType, days: topDays, note: topNote.trim(), year: team.year });
      toast.success(`+${n1(topDays)} ${topType} added for ${team.people.find((p) => p.id === topFor)?.name ?? "them"}`);
      setTopFor(null); setTopNote(""); setTopDays(1);
    } catch (e) { fail(e, "Couldn't add those days."); } finally { setBusy(false); }
  }
  const topPerson = team.people.find((p) => p.id === topFor) ?? null;
  const { isAdmin } = useWorkspaces();
  // permissions a month: only that number is saved (not a copy of every attendance setting)
  const [perLocal, setPerLocal] = useState<number | null>(null);
  const perMonth = perLocal ?? org?.attendance?.permissionsPerMonth ?? 2;
  const perSave = useLastSave<number>(
    async (_, v) => { await savePermissionsPerMonth(v); await refetchOrg(); },
    (_, e) => { setPerLocal(null); fail(e, "Couldn't save that."); },
  );
  function changePerMonth(delta: number) {
    const next = Math.max(0, Math.min(10, (perSave.latest("per") ?? perMonth) + delta));
    setPerLocal(next);
    void perSave.push("per", next);
  }
  const ruleRows = [
    { k: "noticeDays" as const, label: "CL notice", sub: "Working days ahead a casual leave must be asked for", value: String(rules.noticeDays), step: 1 },
    { k: "shortNoticePts" as const, label: "Short-notice cut", sub: "Discipline points per CL asked with less notice", value: n1(rules.shortNoticePts), step: 0.5 },
    { k: "unpaidPts" as const, label: "Unpaid day cut", sub: "Points per day beyond the allowance (same as an absence)", value: n1(rules.unpaidPts), step: 0.5 },
  ];
  const since = team.countingSince ? `${fmtDay(team.countingSince)} ${team.countingSince.slice(0, 4)}` : "";
  const extra = (s: number, t: number): ReactNode => (t ? <span className="t-good">{n1(s)} + {n1(t)}</span> : <span className="t-mute">starting</span>);
  const grantRows = useMemo(() => team.grants, [team.grants]);

  return (
    <section className="lv-grid2">
      {/* the allowance table across the full width (names never cut short), then Rules and Leave added side by side */}
      <div className="lv-card lv-wide">
        {setup ? (
          <>
            <span className="lv-hrow">
              {!team.counting && <span className="lv-st warn">Step 1 of 2</span>}
              <b className="lv-h">{team.counting ? "Edit starting allowance" : "Set the starting allowance"}</b>
            </span>
            <span className="lv-faint lv-under">
              {team.counting
                ? "Only a Super Admin edits these once counting has started. Top-ups stay as they are."
                : `Days each person gets for ${team.year}. Set everyone once, then start counting. After that, days are only added with a top-up, so every change is on record.`}
            </span>
            <div className="lv-tbl allow">
              <span className="lv-th">Member</span><span className="lv-th c">CL</span><span className="lv-th c">SL</span>
              {team.people.map((p) => {
                const v = startOf(p.id);
                return (
                  <div key={p.id} className="lv-tr">
                    <span className="lv-who"><Face name={p.name} imageUrl={p.imageUrl} size={26} /><b>{p.name}</b></span>
                    <span><Stepper value={n1(v.cl)} disabled={!(p.canEditStart ?? team.canEditStart)} onDec={() => changeStart(p.id, "cl", -1)} onInc={() => changeStart(p.id, "cl", 1)} /></span>
                    <span><Stepper value={n1(v.sl)} disabled={!(p.canEditStart ?? team.canEditStart)} onDec={() => changeStart(p.id, "sl", -1)} onInc={() => changeStart(p.id, "sl", 1)} /></span>
                  </div>
                );
              })}
            </div>
            <div className="lv-send">
              {team.counting ? (
                <button type="button" className="lv-btn line" onClick={() => setEditStart(false)}>Done</button>
              ) : (
                <>
                  <button type="button" className="lv-btn pri" onClick={begin} disabled={busy}><Icon name="play_arrow" size={18} />Start counting</button>
                  <span className="lv-faint">Leave already taken this year is counted against it.</span>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="lv-hrow">
              <b className="lv-h">Allowance per person</b>
              {team.canEditRules && <button type="button" className="lv-link" onClick={() => { setEditStart(true); setTopFor(null); }}>Edit starting allowance</button>}
            </div>
            <span className="lv-faint lv-under">Counting since {since}. Total = starting days + top-ups.</span>
            <div className="lv-tbl totals">
              <span className="lv-th">Member</span><span className="lv-th r">CL</span><span className="lv-th r">SL</span><span />
              {team.people.map((p) => {
                const b = p.balance;
                if (!b) return null;
                return (
                  <div key={p.id} className="lv-tr">
                    <span className="lv-who"><Face name={p.name} imageUrl={p.imageUrl} size={26} /><b>{p.name}</b></span>
                    {editRow === p.id ? (["cl", "sl"] as const).map((k) => {
                      const tb = k === "cl" ? b.CL : b.SL;
                      return (
                        <span key={k} className="lv-tot edit">
                          <Stepper value={n1(rowDraft[k])} onDec={() => stepDraft(k, -1)} onInc={() => stepDraft(k, 1)} />
                          <span className="t-mute">starting{tb.topups ? ` + ${n1(tb.topups)} top-up` : ""}</span>
                        </span>
                      );
                    }) : (
                      <>
                        <span className="lv-tot" title={`Starting ${n1(b.CL.start)} + top-ups ${n1(b.CL.topups)}`}><b>{n1(b.CL.total)}</b>{extra(b.CL.start, b.CL.topups)}</span>
                        <span className="lv-tot" title={`Starting ${n1(b.SL.start)} + top-ups ${n1(b.SL.topups)}`}><b>{n1(b.SL.total)}</b>{extra(b.SL.start, b.SL.topups)}</span>
                      </>
                    )}
                    <span className="lv-topcell">
                      {editRow === p.id ? (
                        <>
                          <button type="button" className="lv-btn line" onClick={() => setEditRow(null)}>Cancel</button>
                          <button type="button" className="lv-btn pri sm" disabled={busy} onClick={() => saveRow(p.id)}
                            title={team.canEditRules ? undefined : "Saved once: after that only the Super Admin changes it"}>
                            <Icon name="check" size={16} />Save
                          </button>
                        </>
                      ) : (
                        <>
                          {(p.canEditStart ?? team.canEditRules) && (
                            <button type="button" className="lv-iconbtn" title="Edit the starting days" aria-label={`Edit ${p.name}'s starting days`}
                              onClick={() => openRow(p.id)}>
                              <Icon name="edit" size={16} />
                            </button>
                          )}
                          {(p.canTopUp ?? true) ? (
                            <button type="button" className={"lv-btn top" + (topFor === p.id ? " on" : "")} onClick={() => { setTopFor(p.id); setEditRow(null); setTopType("CL"); setTopDays(1); setTopNote(""); }}>
                              <Icon name="add_circle" size={16} />Top up
                            </button>
                          ) : (
                            <span className="lv-faint" title="Another manager or the Super Admin adds days to your own leave">Your own</span>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {topPerson && topPerson.balance && (
              <div className="lv-topup">
                <b>Top up {topPerson.name}’s leave</b>
                <div className="lv-topup-row">
                  <div className="lv-seg solid">
                    {(["CL", "SL"] as const).map((t) => <button key={t} type="button" className={topType === t ? "on pri" : ""} onClick={() => setTopType(t)}>{t}</button>)}
                  </div>
                  <Stepper wide value={`+${n1(topDays)} d`} onDec={() => setTopDays((d) => Math.max(0.5, d - 0.5))} onInc={() => setTopDays((d) => Math.min(15, d + 0.5))} />
                  <span className="lv-faint">{topType} total {n1(topPerson.balance[topType].total)} → {n1(topPerson.balance[topType].total + topDays)} days</span>
                </div>
                <input value={topNote} onChange={(e) => setTopNote(e.target.value)} maxLength={300} placeholder="Reason (needed), e.g. worked the Sunday shoot" />
                <div className="lv-topup-acts">
                  <button type="button" className="lv-btn line" onClick={() => setTopFor(null)}>Cancel</button>
                  <button type="button" className="lv-btn pri sm" disabled={busy || !topNote.trim()} onClick={saveTop}><Icon name="check" size={17} />Add days</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="lv-card lv-list">
        <b className="lv-h">Rules</b>
        <span className="lv-faint lv-under">Only a Super Admin changes these.</span>
        {ruleRows.map((r) => (
          <div key={r.k} className="lv-rule">
            <span className="lv-rule-l"><b>{r.label}</b><span>{r.sub}</span></span>
            <Stepper value={r.value} disabled={!team.canEditRules}
              onDec={() => changeRule(r.k, -r.step, 0, 10)} onInc={() => changeRule(r.k, r.step, 0, 10)} />
          </div>
        ))}
        <div className="lv-rule">
          <span className="lv-rule-l"><b>Permissions a month</b><span>Up to 2 hours each: morning (come in late) or evening (leave early). Admins change this</span></span>
          <Stepper value={String(perMonth)} disabled={!isAdmin} onDec={() => changePerMonth(-1)} onInc={() => changePerMonth(1)} />
        </div>
        <div className="lv-rule">
          <span className="lv-rule-l"><b>Saturdays are working days</b><span>From the work calendar (Settings › General). Off days and holidays never use leave.</span></span>
          <span className={"lv-st " + (satWorking ? "good" : "mute")}>{satWorking ? "Yes" : "No"}</span>
        </div>
      </div>

      <div className="lv-card lv-list">
        <b className="lv-h">Leave added</b>
        {grantRows.length === 0 && <span className="lv-faint">No top-ups yet.</span>}
        {grantRows.map((g) => (
          <div key={g.id} className="lv-req">
            <TypeChip type={g.type} />
            <span className="lv-req-main"><span><b>{g.name}</b><b className="t-good mono"> +{n1(g.days)}</b></span><span>{g.note}{g.byName ? ` · by ${g.byName}` : ""} · {fmtDay(new Date(new Date(g.at).getTime() + 330 * 60_000).toISOString().slice(0, 10))}</span></span>
          </div>
        ))}
      </div>
    </section>
  );
}

// The page: /leave (?tab=approve or settings).
export function LeavePage() {
  const [params, setParams] = useSearchParams();
  const t = params.get("tab");
  const tab: Tab = t === "approve" || t === "settings" ? t : "apply";
  return (
    <section className="screen lv-page">
      <LeaveScreen startTab={tab} onTab={(next) => setParams(next === "apply" ? {} : { tab: next }, { replace: true })} />
    </section>
  );
}

// Home: the same screen in a side panel (Ask for leave, the balance line, the
// bar's Leave button). Put on the page itself (a portal): the day bar it's
// opened from blurs its background, which would hold a fixed panel inside it.
export function LeavePanel({ onClose, startTab = "attendance" }: { onClose: () => void; startTab?: Tab }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <>
      <div className="lv-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="lv-panel" aria-label="Attendance and leave" role="dialog">
        <button type="button" className="lv-close" onClick={onClose} title="Close" aria-label="Close"><Icon name="close" size={20} /></button>
        <LeaveScreen startTab={startTab} />
      </aside>
    </>,
    document.body,
  );
}
