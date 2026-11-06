import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { Task } from "@/lib/types";
import "./schedule-block.css";
import "./desk-block.css";

// Today's desk: a Schedule task's window (server/src/routes/scheduling.js
// GET/PATCH /tasks/:id/desk). The day's social desk in one place: what waits to
// be scheduled, what its person scheduled that day (by brand), what went live
// with its links that day, and the day's counts of
// negative comments cleaned and leads sent on to sales, with the month's totals.
// Hidden for any other task.

type Desk = {
  desk: boolean;
  day: string;
  waiting: { type: string; shared: number; mine: number }[];
  scheduled: { id: string; permalink: string | null; platformName: string | null; platformKey: string | null; ref: string | null; title: string }[];
  // the posts its person gave a post date that day, by brand
  dated?: { total: number; brands: { brandId: string | null; brand: string; n: number }[] };
  counts: { comments: number; leads: number };
  month: { comments: number; leads: number; days: number };
  canEdit: boolean;
};

const PLAT: Record<string, { ab: string; bg: string }> = {
  instagram: { ab: "IG", bg: "#e1306c" }, facebook: { ab: "FB", bg: "#1877f2" }, youtube: { ab: "YT", bg: "#ff0033" },
};
const dayWords = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function DeskBlock({ task }: { task: Task }) {
  const { data, refetch } = useResource<Desk>(`/tasks/${task.id}/desk`);
  const [busy, setBusy] = useState<"comments" | "leads" | null>(null);
  if (!data?.desk) return null;

  const shared = data.waiting.reduce((n, w) => n + w.shared, 0);
  const mine = data.waiting.reduce((n, w) => n + w.mine, 0);
  const kinds = data.waiting.filter((w) => w.shared + w.mine > 0).map((w) => `${w.shared + w.mine} ${w.type}`).join(" · ");
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) === data.day;

  async function step(key: "comments" | "leads", by: number) {
    const next = Math.max(0, Math.min(999, (data?.counts[key] ?? 0) + by));
    if (next === data?.counts[key]) return;
    setBusy(key);
    try {
      await api(`/tasks/${task.id}/desk`, { method: "PATCH", body: JSON.stringify({ [key]: next }) });
      await refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save that.");
    } finally {
      setBusy(null);
    }
  }
  const counter = (key: "comments" | "leads", label: string, hint: string) => (
    <div className="dsk-count">
      <span className="dsk-count-l"><b>{label}</b><small>{hint}</small></span>
      <span className="dsk-step" role="group" aria-label={label}>
        <button type="button" disabled={!data.canEdit || busy === key || data.counts[key] === 0} onClick={() => step(key, -1)} aria-label={`One fewer: ${label}`}>−</button>
        <b>{data.counts[key]}</b>
        <button type="button" disabled={!data.canEdit || busy === key} onClick={() => step(key, 1)} aria-label={`One more: ${label}`}>+</button>
      </span>
    </div>
  );

  return (
    <section className="sch dsk" aria-label="Today's desk">
      <div className="sch-head">
        <b>{today ? "Today's desk" : `Desk · ${dayWords(data.day)}`}</b>
        <span className="sch-grow" />
        <Link className="dsk-open" to="/scheduling">Open Scheduling ›</Link>
      </div>

      <div className="dsk-part">
        <span className="dsk-h">Waiting to schedule</span>
        <p className="sch-say">
          {shared + mine === 0 ? "Nothing waiting: every approved post is scheduled."
            : <>{kinds}{mine > 0 ? ` · ${mine} taken by ${task.editor_name ?? "them"}, links still to add` : ""}</>}
        </p>
      </div>

      <div className="dsk-part">
        <span className="dsk-h">Scheduled {today ? "today" : `on ${dayWords(data.day)}`}<small>{data.dated?.total ?? 0}</small></span>
        <p className="sch-say">
          {data.dated && data.dated.total > 0
            ? data.dated.brands.map((b) => `${b.brand} ${b.n}`).join(" · ")
            : `Nothing yet. Each post ${task.editor_name ?? "they"} sets a date on counts here, by brand.`}
        </p>
      </div>

      <div className="dsk-part">
        <span className="dsk-h">Live {today ? "today" : `on ${dayWords(data.day)}`}<small>{data.scheduled.length}</small></span>
        {data.scheduled.length === 0 ? (
          <p className="sch-say">Nothing yet. Each post whose links {task.editor_name ? `${task.editor_name} adds` : "they add"} shows here.</p>
        ) : (
          <div className="sch-links dsk-list">
            {data.scheduled.map((p) => {
              const t = (p.platformKey && PLAT[p.platformKey]) || null;
              return (
                <div className="sch-post" key={p.id}>
                  <span className="sch-tile" style={{ background: t?.bg ?? "#71717a" }} aria-hidden="true">{t?.ab ?? (p.platformName ?? "?").slice(0, 2).toUpperCase()}</span>
                  <span className="dsk-ref">{p.ref}</span>
                  <span className="dsk-title">{p.title}</span>
                  {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer">Open ↗</a>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="dsk-part dsk-counts">
        {counter("comments", "Negative comments cleaned", "removed or hidden today")}
        {counter("leads", "Leads sent to sales", "added to the sales tracker today")}
      </div>

      <p className="dsk-month">
        This month: <b>{data.month.comments}</b> comments cleaned · <b>{data.month.leads}</b> leads sent
        {data.month.days > 0 ? ` · over ${data.month.days} desk day${data.month.days === 1 ? "" : "s"}` : ""}
      </p>
    </section>
  );
}
