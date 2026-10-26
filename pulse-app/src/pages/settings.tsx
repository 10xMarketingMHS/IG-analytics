import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { useAuth } from "@/lib/auth-context";
import { useIsSuper, useOrg } from "@/lib/use-org";
import { useReviewAccess } from "@/lib/use-review-access";
import { setWeekStart } from "@/lib/date-range";
import { notifyOn, type NotifyKey } from "@/lib/notify-prefs";
import { CALENDAR_DEFAULTS, LUNCH_MIN, TEA_MIN, capacityFor, storedCapacity, type WorkCalendar } from "@/lib/work-calendar";
import { ACCENTS, useTheme } from "@/components/theme-provider";
import { SCORE_WEIGHTS } from "@/lib/score";
import { DISCIPLINE_CRITERIA } from "@/lib/goal-points";
import { monthName } from "@/lib/goal-periods";
import { TaskRulesSection } from "@/pages/task-rules";
import { ChannelsSection } from "@/pages/channels";
import { EodOversightSection } from "@/pages/eod-oversight";
import { ConnectedAppsSection } from "@/pages/connected-apps";
import { PageAccessSection } from "@/pages/page-access";
import { AttendanceSection } from "@/pages/attendance-settings";
import { AccessSection } from "@/pages/access";
import { SI, Seg, Stepper, Toggle, fmtHours } from "@/pages/settings-ui";
import "./settings.css";

// Settings (Pulse Redesign v5): one page, a menu of sections on the left —
// General, Channels, Content, Tasks & time, Scoring, Access, Notifications and
// Work day — each a stack of flat panels with one setting per row. Everyone but
// an admin sees only General, Content and Notifications. General keeps its changes
// as a draft ("Unsaved changes") until Save; the others save as you go.
// People, logins and roles live in Team › Roster; each person's goals in
// Goals › Set goals. /channels and /task-rules still land here on their own
// section; ?s= picks one.
type Section = "general" | "channels" | "content" | "tasks" | "attendance" | "scoring" | "access" | "pages" | "alerts" | "workday" | "apps";
const SECTION_FOR_PATH: Record<string, Section> = { "/channels": "channels", "/task-rules": "tasks" };
const LEAVE_UNSAVED = "You have changes that aren't saved. Leave them?";

// Three tiers: an editor sees their own look, alerts and the content lists; an
// admin also runs channels, task types and times, attendance rules and the work
// day, and sees the calendar, points, penalties and bands; the Super Admin
// changes those too, and Access.
export function SettingsPage() {
  const { isAdmin, hasPermission, pageRule } = useWorkspaces();
  const isSuper = useIsSuper();
  // Connected apps: the Super Admin, Managers and Asst. Managers — the server says who
  const { data: appsAccess } = useResource<{ allowed: boolean; change?: boolean }>("/connections/access");
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [dirty, setDirty] = useState(false);

  const SECTIONS: { k: Section; l: string; d: string; icon: ReactNode; show: boolean }[] = [
    { k: "general", l: "General", d: "Workspace, work calendar, look", icon: SI.tune, show: true },
    { k: "channels", l: "Channels", d: "Brands and platform accounts", icon: SI.hub, show: pageRule("setChannels", "see", isAdmin) },
    { k: "content", l: "Content", d: "Pillars, types, avatars, formats", icon: SI.category, show: pageRule("setContent", "see", true) },
    { k: "tasks", l: "Tasks & time", d: "Task types, budgets, breaks", icon: SI.timer, show: pageRule("setTasks", "see", isAdmin) },
    { k: "attendance", l: "Attendance", d: "Start of day, late and absent rules", icon: SI.clock, show: pageRule("setAttendance", "see", isAdmin) },
    { k: "scoring", l: "Scoring", d: "How rankings are calculated", icon: SI.chart, show: pageRule("setScoring", "see", isAdmin) },
    { k: "access", l: "Access", d: "Extra permissions per person", icon: SI.admin, show: isSuper || (!isAdmin && hasPermission("access_manage")) },
    { k: "pages", l: "Page access", d: "What each position sees and changes", icon: SI.shield, show: isSuper || isAdmin },
    { k: "alerts", l: "Notifications", d: "What pings you, and where", icon: SI.bell, show: true },
    { k: "workday", l: "Work day", d: "Who started and ended their day", icon: SI.clock, show: pageRule("setWorkday", "see", isAdmin) },
    { k: "apps", l: "Connected apps", d: "Animus, with one line", icon: SI.link, show: !!appsAccess?.allowed },
  ];
  const shown = SECTIONS.filter((s) => s.show);
  const want = (params.get("s") as Section | null) ?? SECTION_FOR_PATH[location.pathname] ?? "general";
  const cur = shown.find((s) => s.k === want) ?? shown[0];
  function go(k: Section) {
    if (k === cur.k) return;
    if (dirty && !window.confirm(LEAVE_UNSAVED)) return;
    setDirty(false);
    navigate(k === "general" ? "/settings" : `/settings?s=${k}`, { replace: true });
  }
  // Closing or reloading the tab with a draft asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <section className="screen st">
      <div className="st-head">
        {dirty && <span className="st-chip warn st-unsaved"><i />Unsaved changes</span>}
        <span className="st-grow" />
        <span className="st-note">
          {SI.shield}
          {isSuper ? "Super Admin · changes apply to everyone" : isAdmin ? "Admin · locked parts are changed by the Super Admin" : "Some sections can only be changed by an admin"}
        </span>
      </div>
      <div className="st-body">
        <nav className="st-nav" aria-label="Settings sections">
          {shown.map((s) => (
            <button key={s.k} type="button" className={cur.k === s.k ? "on" : ""} aria-current={cur.k === s.k ? "page" : undefined} onClick={() => go(s.k)}>
              {s.icon}
              <span><b>{s.l}</b><small>{s.d}</small></span>
            </button>
          ))}
          {isAdmin && (
            <div className="st-navfoot">
              People and login access live in
              <Link to="/my-team?tab=roster" className="st-link">Team · Roster{SI.arrow}</Link>
            </div>
          )}
        </nav>
        <div className="st-main">
          <div className="st-sechead"><h2>{cur.l}</h2><span>{cur.d}</span></div>
          {cur.k === "general" && <GeneralSection onDirty={setDirty} />}
          {cur.k === "channels" && <ChannelsSection />}
          {cur.k === "content" && <ContentSection />}
          {cur.k === "tasks" && <TaskRulesSection />}
          {cur.k === "attendance" && <AttendanceSection onDirty={setDirty} />}
          {cur.k === "scoring" && <ScoringSection />}
          {cur.k === "access" && <AccessSection />}
          {cur.k === "pages" && <PageAccessSection />}
          {cur.k === "alerts" && <NotificationsSection />}
          {cur.k === "workday" && <EodOversightSection />}
          {cur.k === "apps" && <ConnectedAppsSection canChange={appsAccess?.change ?? true} />}
        </div>
      </div>
    </section>
  );
}

// ── General ──────────────────────────────────────────────────────────────────
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// The workspace (name, time zone, week start) and the work calendar, kept as a
// draft until Save; then the review cycle and how Echo looks for you.
function GeneralSection({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { isAdmin, pageRule } = useWorkspaces();
  const { org, refetch } = useOrg();
  const isSuper = !!org?.superAdmin;
  const months = useMemo(() => {
    const d = new Date();
    return [ymOf(new Date(d.getFullYear(), d.getMonth(), 1)), ymOf(new Date(d.getFullYear(), d.getMonth() + 1, 1))];
  }, []);
  const [month, setMonth] = useState(months[0]);
  // Draft values; null = not touched (showing what's saved).
  const [name, setName] = useState<string | null>(null);
  const [week, setWeek] = useState<"mon" | "sun" | null>(null);
  const [cal, setCal] = useState<WorkCalendar | null>(null);
  const [saving, setSaving] = useState(false);
  const [newHoliday, setNewHoliday] = useState("");

  const savedCal = org?.calendar ?? CALENDAR_DEFAULTS;
  const c = cal ?? savedCal;
  const nameDirty = name !== null && name.trim() !== (org?.name ?? "") && name.trim() !== "";
  const weekDirty = week !== null && week !== org?.weekStart;
  const calDirty = cal !== null && JSON.stringify(cal) !== JSON.stringify(savedCal);
  const dirty = nameDirty || weekDirty || calDirty;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const setC = (patch: Partial<WorkCalendar>) => setCal({ ...c, ...patch });
  const canStore = org?.canSaveSettings ?? false;
  // everyone sees the work calendar; only the Super Admin changes it
  const lockCal = !canStore || !isSuper;

  const [y, m] = month.split("-").map(Number);
  const cc = capacityFor(c, y, m - 1);

  function discard() { setName(null); setWeek(null); setCal(null); }
  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (nameDirty) body.name = name!.trim();
      if (weekDirty) body.weekStart = week;
      if (calDirty) body.calendar = cal;
      await api("/org", { method: "PATCH", body: JSON.stringify(body) });
      // The calendar sets this month's and next month's capacity for everyone
      // without their own hours; later months follow it as they come.
      if (calDirty && cal) {
        for (const k of months) {
          const [yy, mm] = k.split("-").map(Number);
          const sc = storedCapacity(cal, yy, mm - 1);
          await api("/goals/capacity", { method: "PUT", body: JSON.stringify({ scope: "org", month: `${k}-01`, ...sc }) });
        }
      }
      if (weekDirty && week) setWeekStart(week);
      await refetch();
      discard();
      toast.success("Settings saved.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {pageRule("setGeneral", "change", isAdmin) && (
        <section className="st-card">
          <div className="st-cardhead"><b>Workspace</b></div>
          <div className="st-row">
            <span className="st-label"><b>Name</b><small>Shown in the sidebar under Echo</small></span>
            <input className="st-in st-wide" value={name ?? org?.name ?? ""} maxLength={60} aria-label="Workspace name"
              onChange={(e) => setName(e.target.value)} disabled={!org} />
          </div>
          <div className="st-row">
            <span className="st-label"><b>Time zone</b><small>Echo runs on India time: timers, due dates and the 6 PM wrap-up</small></span>
            <select className="st-in st-wide" disabled aria-label="Time zone" value="ist"><option value="ist">India · IST (UTC+5:30)</option></select>
          </div>
          <div className="st-row">
            <span className="st-label"><b>Week starts on</b><small>Used by This week and Last week across Echo</small></span>
            <Seg label="Week starts on" value={week ?? org?.weekStart ?? "mon"} options={[["mon", "Monday"], ["sun", "Sunday"]]}
              onChange={(v) => { if (canStore) setWeek(v); else toast.error("The week start needs a database update first."); }} />
          </div>
        </section>
      )}

      <section className="st-card">
        <div className="st-cardhead">
          <b>Work calendar</b>
          <span>Sets each editor's monthly capacity. Goals set on Goals · Set goals must fit inside it.</span>
        </div>
        {!org ? <div className="st-empty">Loading…</div> : (
          <>
            <div className="st-row">
              <span className="st-label"><b>Monday – Friday</b><small>{fmtHours(cc.wdMin / 60)} of work after breaks</small></span>
              <span className="st-times">
                <input type="time" className="st-in" value={c.wdFrom} onChange={(e) => setC({ wdFrom: e.target.value })} aria-label="Weekdays start" disabled={lockCal} />
                to
                <input type="time" className="st-in" value={c.wdTo} onChange={(e) => setC({ wdTo: e.target.value })} aria-label="Weekdays end" disabled={lockCal} />
              </span>
            </div>
            <div className="st-row">
              <span className="st-label"><b>Saturday</b><small>{c.satOff ? "Not a working day" : `${fmtHours(cc.satMin / 60)} of work${c.satBreaks ? " after breaks" : ""}`}</small></span>
              <span className="st-times">
                <input type="time" className="st-in" value={c.satFrom} onChange={(e) => setC({ satFrom: e.target.value })} aria-label="Saturday start" disabled={lockCal || c.satOff} />
                to
                <input type="time" className="st-in" value={c.satTo} onChange={(e) => setC({ satTo: e.target.value })} aria-label="Saturday end" disabled={lockCal || c.satOff} />
                <Toggle on={!c.satOff} onChange={(v) => setC({ satOff: !v })} label="Saturday is a working day" disabled={lockCal} />
              </span>
            </div>
            <div className="st-row">
              <span className="st-label"><b>Sunday</b><small>Never counted</small></span>
              <span className="st-chip">Off</span>
            </div>
            <div className="st-row">
              <span className="st-label"><b>Lunch break</b><small>The same for everyone — part of the 1h 15m daily break allowance</small></span>
              <span className="st-value st-mono">{LUNCH_MIN}m</span>
            </div>
            <div className="st-row">
              <span className="st-label"><b>Tea break</b><small>Two of 15 minutes</small></span>
              <span className="st-value st-mono">{TEA_MIN}m</span>
            </div>
            <div className="st-row">
              <span className="st-label"><b>Breaks on Saturday too</b></span>
              <Toggle on={c.satBreaks} onChange={(v) => setC({ satBreaks: v })} label="Breaks on Saturday too" disabled={lockCal || c.satOff} />
            </div>
            <div className="st-row">
              <span className="st-label"><b>Holidays</b><small>Days the office is shut: nobody is late or absent, and they come out of capacity</small></span>
              <span className="st-holidays">
                {(c.holidays ?? []).map((h) => (
                  <span key={h} className="st-chip">
                    {new Date(`${h}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    {!lockCal && (
                      <button type="button" className="st-chipx" aria-label={`Remove ${h}`}
                        onClick={() => setC({ holidays: (c.holidays ?? []).filter((x) => x !== h) })}>×</button>
                    )}
                  </span>
                ))}
                {!lockCal && (
                  <span className="st-times">
                    <input type="date" className="st-in" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} aria-label="Holiday date" />
                    <button type="button" className="st-btn" disabled={!newHoliday}
                      onClick={() => { setC({ holidays: [...new Set([...(c.holidays ?? []), newHoliday])].sort() }); setNewHoliday(""); }}>Add</button>
                  </span>
                )}
                {lockCal && !(c.holidays ?? []).length && <span className="st-value">None</span>}
              </span>
            </div>
            <div className="st-row">
              <span className="st-label"><b>Sick-leave buffer</b><small>Days per month kept out of every editor's capacity</small></span>
              <Stepper label="sick-leave days" value={`${c.sickDays} day${c.sickDays === 1 ? "" : "s"}`} decDisabled={lockCal || c.sickDays <= 0} incDisabled={lockCal || c.sickDays >= 10}
                onDec={() => setC({ sickDays: c.sickDays - 1 })} onInc={() => setC({ sickDays: c.sickDays + 1 })} />
            </div>
            <div className="st-row">
              <span className="st-label"><b>Capacity adjustment</b><small>Add or remove hours from every editor's monthly capacity</small></span>
              <Stepper label="adjustment hours" value={`${c.adjustHours > 0 ? "+" : ""}${c.adjustHours}h`} decDisabled={lockCal || c.adjustHours <= -100} incDisabled={lockCal || c.adjustHours >= 100}
                onDec={() => setC({ adjustHours: c.adjustHours - 1 })} onInc={() => setC({ adjustHours: c.adjustHours + 1 })} />
            </div>
            <div className="st-row sunk">
              <span className="st-calc">
                <span className="st-calcmonth">
                  <Seg label="Month" value={month} options={months.map((k) => [k, monthName(k, "short")] as [string, string])} onChange={setMonth} />
                  {monthName(month)} · per editor
                </span>
                <span>{cc.days} days − {cc.sundays} Sundays{c.satOff ? ` − ${cc.satCount} Saturdays` : ""}{cc.holidays ? ` − ${cc.holidays} holiday${cc.holidays === 1 ? "" : "s"}` : ""} − {cc.sick} sick leave = {cc.workingDays} working days</span>
                <span>
                  {cc.weekdays} weekdays × {fmtHours(cc.wdMin / 60)}
                  {!c.satOff && ` + ${cc.sats} Saturdays × ${fmtHours(cc.satMin / 60)}`}
                  {c.adjustHours ? ` ${c.adjustHours > 0 ? "+" : "−"} ${Math.abs(c.adjustHours)}h` : ""} = {fmtHours(cc.minutes / 60)}
                </span>
              </span>
              <span className="st-big"><b>{fmtHours(cc.minutes / 60)}</b><span>capacity / editor</span></span>
            </div>
            <div className="st-foot">
              <span className="st-note">
                {!isSuper
                  ? "Only a Super Admin can change the work calendar."
                  : canStore
                  ? `Saving sets ${monthName(months[0]).split(" ")[0]} and ${monthName(months[1]).split(" ")[0]} for everyone without their own hours; later months follow it. Change one person's hours on Goals · Set goals.`
                  : "The work calendar needs a database update before it can be saved."}
              </span>
            </div>
          </>
        )}
      </section>

      <section className="st-card">
        <div className="st-cardhead">
          <b>Review cycle</b>
          <span>Goals are checked twice a month. Goals shows each review on its own, or the whole month.</span>
        </div>
        <div className="st-cycle">
          <div><span>Review 1</span><b>1st – 15th</b></div>
          <div><span>Review 2</span><b>16th – month end</b></div>
          <div><span>Full month</span><b>Both combined</b></div>
        </div>
      </section>
      <Appearance />

      {dirty && (
        <div className="st-savebar" role="region" aria-label="Unsaved changes">
          <span><i />Unsaved changes</span>
          <span className="st-grow" />
          <button type="button" className="st-btn" onClick={discard} disabled={saving}>Discard</button>
          <button type="button" className="st-btn grad" onClick={save} disabled={saving}>{SI.check}{saving ? "Saving…" : "Save changes"}</button>
        </div>
      )}
    </>
  );
}

function Appearance() {
  const { theme, toggle, accent, setAccent } = useTheme();
  return (
    <section className="st-card">
      <div className="st-cardhead">
        <b>Appearance</b>
        <span>Only changes how Echo looks for you, on this browser</span>
      </div>
      <div className="st-row">
        <span className="st-label"><b>Theme</b></span>
        <Seg label="Theme" value={theme} options={[["light", "Light"], ["dark", "Dark"]]} onChange={(t) => { if (t !== theme) toggle(); }} />
      </div>
      <div className="st-row">
        <span className="st-label"><b>Accent</b><small>Tints the background and every highlight</small></span>
        <div className="st-accents" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button key={a.key} type="button" role="radio" aria-checked={accent === a.key} aria-label={a.label} title={a.label}
              className={accent === a.key ? "on" : ""} style={{ background: a.swatch }} onClick={() => setAccent(a.key)} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────
// Which pop-ups Echo shows you, saved on your login so they follow you to any
// browser. Each switch saves as you flip it.
function NotificationsSection() {
  const { user, refreshUser } = useAuth();
  const { isAdmin } = useWorkspaces();
  const review = useReviewAccess();
  const [flip, setFlip] = useState<Partial<Record<NotifyKey, boolean>>>({});
  const on = (k: NotifyKey) => flip[k] ?? notifyOn(user?.notifyPrefs, k);
  async function set(k: NotifyKey, v: boolean) {
    setFlip((s) => ({ ...s, [k]: v }));
    try {
      await api("/users/me", { method: "PATCH", body: JSON.stringify({ notifyPrefs: { [k]: v } }) });
      await refreshUser();
      setFlip((s) => { const n = { ...s }; delete n[k]; return n; });
    } catch (e) {
      setFlip((s) => { const n = { ...s }; delete n[k]; return n; });
      toast.error(e instanceof ApiError ? e.message : "Couldn't save that.");
    }
  }
  const ROWS: [NotifyKey, string, string, boolean][] = [
    ["assigned", "A task is assigned to me", "Someone gives you a task, or a post makes one for you", !!user?.editorId],
    ["review", "Work is waiting for my review", "A task you review lands in review", review.reviewer],
    ["overdue", "A task of mine goes overdue", "One of your tasks passes its due date unfinished", !!user?.editorId],
    ["budget", "A task passes its time budget", "Any task on the team runs past its time", isAdmin],
  ];
  const rows = ROWS.filter((r) => r[3]);
  return (
    <>
      <section className="st-card">
        <div className="st-row st-colhead" style={{ borderTop: 0 }}>
          <span className="st-label"><small>Notify me when</small></span>
          <small>In Echo</small>
        </div>
        {rows.length === 0 ? (
          <div className="st-empty">Your login isn't linked to a team member, so there's nothing to tell you about yet.</div>
        ) : rows.map(([k, l, d]) => (
          <div className="st-row" key={k}>
            <span className="st-label"><b>{l}</b><small>{d}</small></span>
            <Toggle on={on(k)} onChange={(v) => set(k, v)} label={l} />
          </div>
        ))}
      </section>
      <section className="st-card">
        <div className="st-row" style={{ borderTop: 0 }}>
          <span className="st-label"><b>Quiet outside working hours</b><small>Hold everything except overdue alerts until working hours (the work calendar in General)</small></span>
          <Toggle on={on("quiet")} onChange={(v) => set("quiet", v)} label="Quiet outside working hours" />
        </div>
      </section>
      <span className="st-note">
        These are pop-ups inside Echo while it's open. Email alerts and a daily digest email need an email service, which Echo doesn't have yet.
      </span>
    </>
  );
}

// ── Content ──────────────────────────────────────────────────────────────────
type TxTab = "pillars" | "avatars" | "formats";
type PostRef = { pillar_id?: string; avatar_id?: string; format_id?: string; content_type_id?: string; is_collab_mirror?: boolean };

function ContentSection() {
  const { taxonomy, refetch } = useTaxonomy();
  const { hasPermission } = useWorkspaces();
  const canEdit = hasPermission("content_taxonomy");
  const { data: postData } = useResource<{ posts: PostRef[] }>("/posts?channel=all");
  const [tab, setTab] = useState<TxTab>("pillars");
  const [newName, setNewName] = useState("");
  const [newPT, setNewPT] = useState<"reel" | "carousel">("reel");
  const [typeFor, setTypeFor] = useState<string | null>(null);
  const [typeName, setTypeName] = useState("");

  // How many posts use each pillar, avatar, format and content type — an item
  // in use can't be deleted (the server refuses it too).
  const used = useMemo(() => {
    const m = new Map<string, number>();
    const bump = (id?: string) => { if (id) m.set(id, (m.get(id) ?? 0) + 1); };
    for (const p of postData?.posts ?? []) {
      if (p.is_collab_mirror) continue;
      bump(p.pillar_id); bump(p.avatar_id); bump(p.format_id); bump(p.content_type_id);
    }
    return m;
  }, [postData]);
  const countOf = (id: string) => (postData ? used.get(id) ?? 0 : null);

  async function add(path: string, body: object, label: string) {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await refetch();
      toast.success(`${label} added.`);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add.");
      return false;
    }
  }
  async function remove(path: string, name: string, label: string) {
    if (!window.confirm(`Delete ${label.toLowerCase()} "${name}"?`)) return;
    try {
      await api(path, { method: "DELETE" });
      await refetch();
      toast.success(`${label} deleted.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete.");
    }
  }
  async function addNew() {
    const name = newName.trim();
    if (!name) return;
    const ok = tab === "pillars" ? await add("/pillars", { name }, "Pillar")
      : tab === "avatars" ? await add("/avatars", { name }, "Avatar")
      : await add("/formats", { name, postType: newPT }, "Format");
    if (ok) setNewName("");
  }
  async function addType(pillarId: string) {
    const name = typeName.trim();
    if (!name) { setTypeFor(null); return; }
    if (await add("/content-types", { name, pillarId }, "Content type")) { setTypeName(""); setTypeFor(null); }
  }

  const HINT: Record<TxTab, string> = {
    pillars: "Top-level themes. Each holds its own content types.",
    avatars: "Who a post speaks to — powers Views by avatar.",
    formats: "Shared across every pillar and channel.",
  };
  const PH: Record<TxTab, string> = { pillars: "New pillar name", avatars: "New avatar name", formats: "New format name" };
  const dot = (i: number, shift: number) => `oklch(0.66 0.13 ${(i * 67 + shift) % 360})`;
  const usedText = (n: number | null) => (n == null ? "" : n ? `${n} post${n === 1 ? "" : "s"}` : "Not used yet");
  const delBtn = (n: number | null, onDel: () => void, what: string) => !canEdit ? null : n ? (
    <button type="button" className="st-icobtn locked" title={`In use by ${n} post${n === 1 ? "" : "s"}`} aria-label={`${what} is in use`} disabled>{SI.lock}</button>
  ) : (
    <button type="button" className="st-icobtn" title="Delete" aria-label={`Delete ${what}`} onClick={onDel}>{SI.trash}</button>
  );

  return (
    <>
      <section className="st-card">
        <div className="st-row" style={{ borderTop: 0 }}>
          <Seg label="What to edit" value={tab} options={[["pillars", "Pillars"], ["avatars", "Audience avatars"], ["formats", "Formats"]]}
            onChange={(t) => { setTab(t); setNewName(""); }} />
          <span className="st-note" style={{ flex: "1 1 160px" }}>{HINT[tab]}</span>
        </div>
        {!taxonomy ? (
          <div className="st-empty">Loading…</div>
        ) : tab === "pillars" ? (
          taxonomy.pillars.length === 0 ? <div className="st-empty">No pillars yet.</div> : taxonomy.pillars.map((p, i) => {
            const types = taxonomy.contentTypes.filter((c) => c.pillar_id === p.id);
            const n = countOf(p.id);
            return (
              <div className="st-row" key={p.id}>
                <span className="st-tx">
                  <i style={{ background: dot(i, 30) }} />
                  <span>
                    <b><span className="st-chip ser">P{p.serial}</span>{p.name}</b>
                    {(types.length > 0 || canEdit) && (
                      <span className="st-types">
                        {types.map((c) => {
                          const tn = countOf(c.id);
                          return (
                            <span className="st-chip" key={c.id} title={tn ? `${tn} post${tn === 1 ? "" : "s"}` : undefined}>
                              <span className="st-chip ser">T{c.serial}</span>{c.name}
                              {canEdit && !tn && (
                                <button type="button" aria-label={`Delete content type ${c.name}`} title="Delete" onClick={() => remove(`/content-types/${c.id}`, c.name, "Content type")}>×</button>
                              )}
                            </span>
                          );
                        })}
                        {canEdit && (typeFor === p.id ? (
                          <input className="st-chipin" autoFocus placeholder="New content type" value={typeName}
                            onChange={(e) => setTypeName(e.target.value)} onBlur={() => addType(p.id)}
                            onKeyDown={(e) => { if (e.key === "Enter") addType(p.id); if (e.key === "Escape") { setTypeName(""); setTypeFor(null); } }} />
                        ) : (
                          <button type="button" className="st-chipadd" onClick={() => { setTypeFor(p.id); setTypeName(""); }}>{SI.plus}Type</button>
                        ))}
                      </span>
                    )}
                  </span>
                </span>
                <span className="st-used">{usedText(n)}</span>
                {delBtn(n, () => remove(`/pillars/${p.id}`, p.name, "Pillar"), p.name)}
              </div>
            );
          })
        ) : tab === "avatars" ? (
          taxonomy.avatars.length === 0 ? <div className="st-empty">No avatars yet.</div> : taxonomy.avatars.map((a, i) => {
            const n = countOf(a.id);
            return (
              <div className="st-row" key={a.id}>
                <span className="st-tx"><i style={{ background: dot(i, 200) }} /><span><b>{a.name}</b></span></span>
                <span className="st-used">{usedText(n)}</span>
                {delBtn(n, () => remove(`/avatars/${a.id}`, a.name, "Avatar"), a.name)}
              </div>
            );
          })
        ) : (
          taxonomy.formats.length === 0 ? <div className="st-empty">No formats yet.</div> : taxonomy.formats.map((f, i) => {
            const n = countOf(f.id);
            return (
              <div className="st-row" key={f.id}>
                <span className="st-tx">
                  <i style={{ background: dot(i, 120) }} />
                  <span><b><span className="st-chip ser">F{f.serial}</span>{f.name} <span className={"st-pt " + (f.post_type === "reel" ? "reel" : "carousel")}>{f.post_type}</span></b></span>
                </span>
                <span className="st-used">{usedText(n)}</span>
                {delBtn(n, () => remove(`/formats/${f.id}`, f.name, "Format"), f.name)}
              </div>
            );
          })
        )}
        {canEdit && taxonomy && (
          <div className="st-foot">
            <input className="st-in grow" placeholder={PH[tab]} value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addNew(); }} />
            {tab === "formats" && (
              <select className="st-in" value={newPT} onChange={(e) => setNewPT(e.target.value as "reel" | "carousel")} aria-label="Post type" style={{ width: 120 }}>
                <option value="reel">Reel</option>
                <option value="carousel">Carousel</option>
              </select>
            )}
            <button type="button" className="st-btn pri" disabled={!newName.trim()} onClick={addNew}>{SI.plus}Add</button>
          </div>
        )}
      </section>
      <span className="st-note">
        {SI.lockSm}
        {canEdit
          ? "Items in use can't be deleted — reassign their posts first. P#, T# and F# numbers never change, even after a delete."
          : "Only admins can add or remove these."}
      </span>
    </>
  );
}

// ── Scoring ──────────────────────────────────────────────────────────────────
type Thresholds = { epiMinPct: number; mpiMinPct: number; isDefault?: boolean };

function ScoringSection() {
  const { isAdmin, hasPermission, pageRule } = useWorkspaces();
  const isSuper = useIsSuper();
  const W: [string, number][] = [
    ["View", SCORE_WEIGHTS.view], ["Like", SCORE_WEIGHTS.like], ["Comment", SCORE_WEIGHTS.comment],
    ["Share", SCORE_WEIGHTS.share], ["Save", SCORE_WEIGHTS.save],
  ];
  const total = W.reduce((s, [, w]) => s + w, 0);
  return (
    <>
      <section className="st-card">
        <div className="st-cardhead">
          <b>Performance score · content</b>
          <span>Each count becomes a rate of reach, then gets a weight. Every post's score in Analytics and the Leaderboard comes from this.</span>
        </div>
        {W.map(([l, w]) => (
          <div className="st-row" key={l}>
            <span className="st-wl">{l} rate</span>
            <span className="st-weight" aria-hidden="true"><i style={{ width: `${w * 2}%` }} /></span>
            <b className="st-wv">× {w}</b>
          </div>
        ))}
        <div className="st-foot">
          <span className="st-note st-mono">{W.map(([l, w]) => `${l} × ${w}`).join("  +  ")}</span>
          <span className={"st-chip " + (total === 100 ? "good" : "bad")}>{total === 100 ? SI.checkCircle : SI.error}Weights total {total}</span>
        </div>
      </section>

      <section className="st-card">
        <div className="st-cardhead">
          <b>Work score · task points</b>
          <span>Ranks the team on My Team and the Leaderboard. A finished task earns its type's points, less if it was late.</span>
        </div>
        {([
          ["On or before the due date", "Full points"],
          ["1 day late", "Half the points"],
          ["2 days late", "No points"],
          ["3 or more days late", "Points taken back"],
          ["Waiting for a reviewer", "Doesn't count as late"],
        ] as const).map(([l, v]) => (
          <div className="st-row" key={l}><span className="st-label"><b>{l}</b></span><span className="st-value">{v}</span></div>
        ))}
        {hasPermission("task_settings") && (
          <div className="st-foot">
            <span className="st-note">Each task type's points are set in Tasks & time.</span>
            <Link to="/settings?s=tasks" className="st-link">Tasks & time{SI.arrow}</Link>
          </div>
        )}
      </section>

      {pageRule("setScoring", "see", isAdmin) && <PerformanceBands canEdit={isSuper} />}

      <section className="st-card">
        <div className="st-cardhead">
          <b>Discipline ratings</b>
          <span>Rated 0–5 per person each month on Goals · Discipline. Together they make up 20% of the goal score.</span>
        </div>
        <div className="st-crit">
          {DISCIPLINE_CRITERIA.map((c, i) => <span key={c.key}><i>{i + 1}</i>{c.label}</span>)}
        </div>
      </section>
    </>
  );
}

// Management Performance: the two cut-offs that band each person's Overall
// Performance % into EPI / MPI / LPI (Leaderboard › Management Performance).
// Admins see them; only the Super Admin changes them.
function PerformanceBands({ canEdit }: { canEdit: boolean }) {
  const [thr, setThr] = useState<Thresholds | null>(null);
  const [epi, setEpi] = useState("85");
  const [mpi, setMpi] = useState("75");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Thresholds>("/management-performance/thresholds")
      .then((d) => { setThr(d); setEpi(String(d.epiMinPct)); setMpi(String(d.mpiMinPct)); })
      .catch(() => setThr({ epiMinPct: 85, mpiMinPct: 75, isDefault: true }));
  }, []);

  const epiN = Number(epi), mpiN = Number(mpi);
  const valid = epiN > 0 && mpiN > 0 && epiN <= 100 && mpiN <= 100 && mpiN <= epiN;
  const changed = !!thr && (epiN !== thr.epiMinPct || mpiN !== thr.mpiMinPct);

  async function save() {
    if (!valid) { toast.error("The MPI minimum can't be higher than the EPI minimum."); return; }
    setSaving(true);
    try {
      const saved = await api<Thresholds>("/management-performance/thresholds", { method: "PUT", body: JSON.stringify({ epiMinPct: epiN, mpiMinPct: mpiN }) });
      setThr(saved);
      toast.success("Bands saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="st-card">
      <div className="st-cardhead">
        <b>Management performance bands</b>
        <span>Overall Performance % = goal points earned (80%) + discipline (20%), out of the goal points set. Shown on Leaderboard · Management Performance.</span>
      </div>
      {!thr ? <div className="st-empty">Loading…</div> : (
        <>
          <div className="st-row">
            <span className="st-label"><b><span className="st-band epi">EPI</span></b><small>{epiN}% and above</small></span>
            <span className="st-pct"><input className="st-in" type="number" min={1} max={100} step={1} value={epi} onChange={(e) => setEpi(e.target.value)} aria-label="EPI minimum percent" disabled={!canEdit} />%</span>
          </div>
          <div className="st-row">
            <span className="st-label"><b><span className="st-band mpi">MPI</span></b><small>{mpiN}% up to {epiN}%</small></span>
            <span className="st-pct"><input className="st-in" type="number" min={1} max={100} step={1} value={mpi} onChange={(e) => setMpi(e.target.value)} aria-label="MPI minimum percent" disabled={!canEdit} />%</span>
          </div>
          <div className="st-row">
            <span className="st-label"><b><span className="st-band lpi">LPI</span></b><small>Below {mpiN}%</small></span>
          </div>
          <div className="st-foot">
            <span className="st-note" style={valid ? undefined : { color: "var(--st-bad)" }}>
              {!canEdit ? "Only a Super Admin can change the bands." : !valid ? "The MPI minimum can't be higher than the EPI minimum." : thr.isDefault ? "These are the defaults — not saved yet." : "Saved."}
            </span>
            {canEdit && <button type="button" className="st-btn pri" disabled={!valid || saving || (!changed && !thr.isDefault)} onClick={save}>{saving ? "Saving…" : "Save bands"}</button>}
          </div>
        </>
      )}
    </section>
  );
}
