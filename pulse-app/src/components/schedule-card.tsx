import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useResource } from "@/lib/use-resource";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { clockWords, dayWords, leftTone, leftWords, linksDueAt, scheduleStage, useNow } from "@/lib/schedule";
import { brandShort } from "@/lib/brand-short";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./schedule-card.css";

// Home, for this month's schedulers: your schedule at a glance. Need to
// schedule (only while something waits): approved work with no post date yet,
// the shared list's and any you took. Today: what
// goes out today (and any whose links are still due from earlier days);
// Upcoming: what you've dated ahead. Each opens its task window, the same one
// Scheduling opens. Data: GET /scheduling (server/src/routes/scheduling.js),
// kept to what you took. Nothing for anyone without a Schedule goal. A box
// with work from two or more brands gets their short names (DF, MHS: Settings ›
// Channels) to filter it by.

type Data = { tasks: Task[]; me: string | null; scheduler: boolean; today?: { editorId: string; total: number }[] };
type When = "today" | "late" | "ahead" | "todo";
type Item = { t: Task; when: When };
const UPCOMING_SHOWN = 6;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const weekday = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short" });

export function ScheduleCard() {
  const { data: access } = useResource<{ allowed: boolean; scheduler: boolean }>("/scheduling/access");
  if (!access?.scheduler) return null;
  return <ScheduleCardBody />;
}

function ScheduleCardBody() {
  const { data, refetch } = useResource<Data>("/scheduling");
  const { editors } = useEditors();
  const { active, workspaces } = useWorkspaces();
  const [openId, setOpenId] = useState<string | null>(null);
  // each box's brand filter: box → brand id
  const [pick, setPick] = useState<Record<string, string>>({});
  const { data: brandData } = useResource<{ brands: { id: string; name: string; short_name?: string | null }[] }>("/brands");
  const now = useNow();
  if (!data?.me) return null;

  const day = istToday();
  const mine = data.tasks.filter((t) => t.scheduler_id === data.me && t.post_on);
  const byTime = (a: Task, b: Task) => (a.post_on ?? "").localeCompare(b.post_on ?? "") || (a.post_time ?? "99").localeCompare(b.post_time ?? "99");
  // earlier days still waiting for their links come first, then today's
  const late = mine.filter((t) => t.post_on! < day && scheduleStage(t, day) === "links_due").sort(byTime);
  const todays = mine.filter((t) => t.post_on === day).sort(byTime);
  const upcoming = mine.filter((t) => t.post_on! > day).sort(byTime);
  // approved and waiting for a post date: the shared list's, and any you took without dating it — oldest first
  const toDate = data.tasks.filter((t) => (!t.scheduler_id || t.scheduler_id === data.me) && scheduleStage(t, day) === "to_schedule")
    .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));
  const waiting = toDate.length;
  const doneToday = data.today?.find((p) => p.editorId === data.me)?.total ?? 0;
  const openTask = openId ? data.tasks.find((t) => t.id === openId) ?? null : null;
  const brandOf = new Map((brandData?.brands ?? []).map((b) => [b.id, b]));
  const shortOf = (t: Task) => (t.channel_id ? brandShort(brandOf.get(t.channel_id)?.name ?? t.channel_name, brandOf.get(t.channel_id)?.short_name) : null);

  const row = ({ t, when }: Item) => {
    const stage = scheduleStage(t, day);
    const left = t.post_on ? linksDueAt(t.post_on).getTime() - now : 0;
    return (
      <button key={t.id} type="button" className="scd-row" onClick={() => setOpenId(t.id)}>
        <span className="scd-when">
          {when === "todo" ? <><b>{t.completed_at ? dayWords(t.completed_at.slice(0, 10)) : "—"}</b><small>approved</small></>
            : when === "ahead" ? <><b>{weekday(t.post_on!)}</b><small>{dayWords(t.post_on!)}</small></>
            : when === "late" ? <><b>{dayWords(t.post_on!)}</b><small>went out</small></>
            : <><b>{t.post_time ? clockWords(t.post_time) : "Today"}</b><small>{t.post_time ? "today" : "any time"}</small></>}
        </span>
        <span className="scd-what">
          <b>{t.title}</b>
          <small title={t.channel_name ?? undefined}>{[t.sid, shortOf(t), t.content_format_name].filter(Boolean).join(" · ")}</small>
        </span>
        {when === "todo" ? <span className="scd-tag due">Set date</span>
          : stage === "live" ? <span className="scd-tag live">Live</span>
          : when === "ahead" ? <span className="scd-tag">Dated</span>
          : <span className={"scd-tag due " + leftTone(left)}>{when === "late" || left < 0 ? `Add links · ${leftWords(left)}` : "To post"}</span>}
      </button>
    );
  };

  // a box: its head (with its brands' short names to filter by, when it has two
  // or more), its first few, and the way to the rest
  function column(key: string, title: string, all: Item[], empty: string, cls = ""): ReactNode {
    const counts = new Map<string, number>();
    for (const { t } of all) if (t.channel_id) counts.set(t.channel_id, (counts.get(t.channel_id) ?? 0) + 1);
    const brands = [...counts].sort((a, b) => b[1] - a[1]);
    const on = pick[key] && counts.has(pick[key]) ? pick[key] : "";
    const items = on ? all.filter(({ t }) => t.channel_id === on) : all;
    const toggle = (id: string) => setPick((p) => ({ ...p, [key]: p[key] === id ? "" : id }));
    return (
      <div className={"scd-col" + (cls ? ` ${cls}` : "")} key={key}>
        <span className="scd-h">
          {title}<small>{items.length}</small>
          {brands.length > 1 && (
            <span className="scd-brands" role="group" aria-label={`${title}: brand`}>
              {brands.map(([id, n]) => {
                const b = brandOf.get(id);
                const name = b?.name ?? all.find(({ t }) => t.channel_id === id)?.t.channel_name ?? "Brand";
                return (
                  <button key={id} type="button" className={on === id ? "on" : ""} aria-pressed={on === id} title={`${name}: ${n}`} onClick={() => toggle(id)}>
                    {brandShort(name, b?.short_name)}
                  </button>
                );
              })}
            </span>
          )}
        </span>
        {items.length === 0 ? (
          <p className="scd-none">{empty}</p>
        ) : (
          <div className="scd-list">
            {items.slice(0, UPCOMING_SHOWN).map(row)}
            {items.length > UPCOMING_SHOWN && <Link className="scd-more" to="/scheduling">+{items.length - UPCOMING_SHOWN} more in Scheduling</Link>}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="scd" aria-label="Your schedule">
      <div className="scd-head">
        <span className="scd-ic" aria-hidden="true">🗓️</span>
        <span className="scd-title">
          <b>Your schedule</b>
          <small>{doneToday > 0 ? `You scheduled ${doneToday} today` : "Nothing scheduled by you yet today"}</small>
        </span>
        <Link className="scd-go" to="/scheduling">Open Scheduling →</Link>
      </div>
      <div className={"scd-cols" + (waiting > 0 ? " three" : "")}>
        {waiting > 0 && column("need", "Need to schedule", toDate.map((t) => ({ t, when: "todo" as const })), "", "need")}
        {column("today", "Today", [...late.map((t) => ({ t, when: "late" as const })), ...todays.map((t) => ({ t, when: "today" as const }))], "Nothing goes out today.")}
        {column("upcoming", "Upcoming", upcoming.map((t) => ({ t, when: "ahead" as const })), "Nothing dated ahead yet.")}
      </div>
      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite={active?.role !== "viewer"} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => { setOpenId(null); refetch(); }}
          onChanged={() => { refetch(); }}
          onCreated={() => {}}
        />
      )}
    </section>
  );
}
