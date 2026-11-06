import { useState } from "react";
import { Link } from "react-router-dom";
import { useResource } from "@/lib/use-resource";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { clockWords, dayWords, leftTone, leftWords, linksDueAt, scheduleStage, useNow } from "@/lib/schedule";
import { TaskPanel } from "@/pages/tasks";
import type { Task } from "@/lib/types";
import "./schedule-card.css";

// Home, for this month's schedulers: your schedule at a glance. Today: what
// goes out today (and any whose links are still due from earlier days);
// Upcoming: what you've dated ahead. Each opens its task window, the same one
// Scheduling opens. Data: GET /scheduling (server/src/routes/scheduling.js),
// kept to what you took. Nothing for anyone without a Schedule goal.

type Data = { tasks: Task[]; me: string | null; scheduler: boolean; today?: { editorId: string; total: number }[] };
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
  const now = useNow();
  if (!data?.me) return null;

  const day = istToday();
  const mine = data.tasks.filter((t) => t.scheduler_id === data.me && t.post_on);
  const byTime = (a: Task, b: Task) => (a.post_on ?? "").localeCompare(b.post_on ?? "") || (a.post_time ?? "99").localeCompare(b.post_time ?? "99");
  // earlier days still waiting for their links come first, then today's
  const late = mine.filter((t) => t.post_on! < day && scheduleStage(t, day) === "links_due").sort(byTime);
  const todays = mine.filter((t) => t.post_on === day).sort(byTime);
  const upcoming = mine.filter((t) => t.post_on! > day).sort(byTime);
  const waiting = data.tasks.filter((t) => !t.scheduler_id && scheduleStage(t, day) === "to_schedule").length;
  const doneToday = data.today?.find((p) => p.editorId === data.me)?.total ?? 0;
  const openTask = openId ? data.tasks.find((t) => t.id === openId) ?? null : null;

  const row = (t: Task, when: "today" | "late" | "ahead") => {
    const stage = scheduleStage(t, day);
    const left = t.post_on ? linksDueAt(t.post_on).getTime() - now : 0;
    return (
      <button key={t.id} type="button" className="scd-row" onClick={() => setOpenId(t.id)}>
        <span className="scd-when">
          {when === "ahead" ? <><b>{weekday(t.post_on!)}</b><small>{dayWords(t.post_on!)}</small></>
            : when === "late" ? <><b>{dayWords(t.post_on!)}</b><small>went out</small></>
            : <><b>{t.post_time ? clockWords(t.post_time) : "Today"}</b><small>{t.post_time ? "today" : "any time"}</small></>}
        </span>
        <span className="scd-what">
          <b>{t.title}</b>
          <small>{[t.sid, t.channel_name, t.content_format_name].filter(Boolean).join(" · ")}</small>
        </span>
        {stage === "live" ? <span className="scd-tag live">Live</span>
          : when === "ahead" ? <span className="scd-tag">Dated</span>
          : <span className={"scd-tag due " + leftTone(left)}>{when === "late" || left < 0 ? `Add links · ${leftWords(left)}` : "To post"}</span>}
      </button>
    );
  };

  return (
    <section className="scd" aria-label="Your schedule">
      <div className="scd-head">
        <span className="scd-ic" aria-hidden="true">🗓️</span>
        <span className="scd-title">
          <b>Your schedule</b>
          <small>{doneToday > 0 ? `You scheduled ${doneToday} today` : "Nothing scheduled by you yet today"}{waiting > 0 ? ` · ${waiting} waiting to be scheduled` : ""}</small>
        </span>
        <Link className="scd-go" to="/scheduling">Open Scheduling →</Link>
      </div>
      <div className="scd-cols">
        <div className="scd-col">
          <span className="scd-h">Today<small>{todays.length + late.length}</small></span>
          {todays.length + late.length === 0 ? (
            <p className="scd-none">Nothing goes out today.{waiting > 0 ? " Set a post date on one waiting in Scheduling." : ""}</p>
          ) : (
            <div className="scd-list">{late.map((t) => row(t, "late"))}{todays.map((t) => row(t, "today"))}</div>
          )}
        </div>
        <div className="scd-col">
          <span className="scd-h">Upcoming<small>{upcoming.length}</small></span>
          {upcoming.length === 0 ? (
            <p className="scd-none">Nothing dated ahead yet.</p>
          ) : (
            <div className="scd-list">
              {upcoming.slice(0, UPCOMING_SHOWN).map((t) => row(t, "ahead"))}
              {upcoming.length > UPCOMING_SHOWN && <Link className="scd-more" to="/scheduling">+{upcoming.length - UPCOMING_SHOWN} more in Scheduling</Link>}
            </div>
          )}
        </div>
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
