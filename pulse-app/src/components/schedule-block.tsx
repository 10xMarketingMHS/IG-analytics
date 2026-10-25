import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { STAGE_WORDS, clockWords, dayWords, type TaskSchedule } from "@/lib/schedule";
import type { Editor, Task, Taxonomy } from "@/lib/types";
import "./schedule-block.css";

// The Scheduling part of an approved Social task's window
// (server/src/routes/scheduling.js): it waits in the schedulers' shared list;
// setting its post date takes it; then each platform's link is pasted — each
// becomes a post on the same SID, with the task's brand, title, date and editor. Only the post's own details
// (pillar, content type, format, avatar) are asked, once, started from the
// last post's. Hidden for tasks that aren't in scheduling.

const PLAT_TILE: Record<string, { ab: string; bg: string }> = {
  instagram: { ab: "IG", bg: "#e1306c" }, facebook: { ab: "FB", bg: "#1877f2" }, youtube: { ab: "YT", bg: "#ff0033" },
};
const tileOf = (key: string | null, name: string | null) => {
  const t = (key && PLAT_TILE[key]) || null;
  return <span className="sch-tile" style={{ background: t?.bg ?? "#71717a" }} aria-hidden="true">{t?.ab ?? (name ?? "?").slice(0, 2).toUpperCase()}</span>;
};
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function ScheduleBlock({ task, onChanged }: { task: Task; editors?: Editor[]; onChanged: () => void }) {
  const { data, refetch } = useResource<TaskSchedule>(`/tasks/${task.id}/schedule`);
  const s = data?.ready && data.inFlow ? data : null;
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  useEffect(() => { setDate(s?.postOn ?? ""); setTime(s?.postTime ?? ""); }, [s?.postOn, s?.postTime]);
  const [busy, setBusy] = useState(false);
  if (!s) return null;

  const stage = s.stage ?? "to_schedule";
  const when = s.postOn ? `${dayWords(s.postOn)}${s.postTime ? `, ${clockWords(s.postTime)}` : ""}` : "";
  const who = s.mine ? "you" : s.schedulerName ?? "a scheduler";
  const live = (s.posts ?? []).map((p) => p.platformName).filter(Boolean).join(" and ");
  const say = stage === "to_schedule"
    ? (!s.schedulerId
      ? (s.canSchedule ? "Approved and in the schedulers' list. Set the day it goes out to take it; Echo reminds you on the day." : "Approved. Waiting for a scheduler to take it.")
      : s.canSchedule ? "Approved. Pick the day it goes out; Echo reminds you on the day." : `Approved. Waiting for ${who} to set the post date.`)
    : stage === "scheduled"
      ? `Goes out on ${when}. ${s.canSchedule ? `Once it's up, paste its links here; Echo asks for them on ${dayWords(s.linksDueOn!)}.` : `Its links are due on ${dayWords(s.linksDueOn!)}.`}`
      : stage === "links_due"
        ? (s.canSchedule ? `Posted on ${when}? Paste each platform's link below.` : `Posted on ${when}; waiting for ${who} to add its links.`)
        : `Live on ${live}. Its numbers sync into Analytics and ${task.editor_name ?? "the editor"}'s performance.`;
  const open = (s.platforms ?? []).filter((p) => !(s.posts ?? []).some((x) => x.platformId === p.platformId));
  const dateChanged = date !== (s.postOn ?? "") || time !== (s.postTime ?? "");

  async function save(body: object, ok: string) {
    setBusy(true);
    try {
      await api(`/tasks/${task.id}/schedule`, { method: "PATCH", body: JSON.stringify(body) });
      await refetch();
      onChanged();
      toast.success(ok);
    } catch (e) {
      toast.error(errText(e, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sch" aria-label="Scheduling">
      <div className="sch-head">
        <b>Scheduling</b>
        <span className={"sch-pill " + stage}>{STAGE_WORDS[stage]}</span>
        <span className="sch-grow" />
        {s.canChangeScheduler ? (
          <label className="sch-who">Scheduler
            <select value={s.schedulerId ?? ""} disabled={busy} aria-label="Who schedules it"
              onChange={(e) => save({ schedulerId: e.target.value || null }, e.target.value ? "Handed to them." : "Back in the shared list.")}>
              <option value="">Not taken (shared list)</option>
              {(s.schedulers ?? []).concat(s.schedulerId && !(s.schedulers ?? []).some((x) => x.id === s.schedulerId) ? [{ id: s.schedulerId, name: s.schedulerName ?? "Scheduler" }] : [])
                .map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        ) : <span className="sch-who">Scheduler <b>{s.mine ? "You" : s.schedulerName ?? "not taken yet"}</b></span>}
      </div>
      <p className="sch-say">{say}</p>

      {s.canSchedule ? (
        <div className="sch-date">
          <label>Post on<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Time <small>(optional)</small><input type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} /></label>
          {dateChanged && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy}
              onClick={() => save({ postOn: date || null, postTime: date && time ? time : null }, date ? `Set to post on ${dayWords(date)}.${s.schedulerId ? "" : " It's yours now."}` : "Post date cleared. It's back in the shared list.")}>
              {busy ? "Saving…" : date ? "Save date" : "Clear date"}
            </button>
          )}
        </div>
      ) : when ? <div className="sch-date-ro">Posts on <b>{when}</b></div> : null}

      {((s.posts?.length ?? 0) > 0 || (s.canSchedule && !!s.postOn && open.length > 0)) && (
        <div className="sch-links">
          {(s.posts ?? []).map((p) => (
            <div className="sch-post" key={p.id}>
              {tileOf(p.platformKey, p.platformName)}
              <span>{p.platformName}</span>
              {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer">Open the post ↗</a>}
              <span className="sch-num">{p.metricsUpdatedAt ? `${p.views.toLocaleString("en-IN")} views · ${p.saves.toLocaleString("en-IN")} saves` : "Numbers come with the next sync"}</span>
            </div>
          ))}
          {s.canSchedule && !!s.postOn && open.length > 0 && (
            <LinkForm task={task} open={open} defaults={s.defaults ?? null}
              onDone={async () => { await refetch(); onChanged(); }} />
          )}
        </div>
      )}
    </section>
  );
}

// A link box per platform still to post on, then the post's details (once a link is in) and Add.
function LinkForm({ task, open, defaults, onDone }: {
  task: Task;
  open: NonNullable<TaskSchedule["platforms"]>;
  defaults: TaskSchedule["defaults"];
  onDone: () => Promise<void>;
}) {
  const { data: tax } = useResource<Taxonomy>(`/taxonomy?channel=${task.channel_id}`);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [d, setD] = useState(defaults ?? { pillarId: "", contentTypeId: "", formatId: "", avatarId: "" });
  const [busy, setBusy] = useState(false);
  const pasted = open.filter((p) => (links[p.platformId] ?? "").trim());
  const types = (tax?.contentTypes ?? []).filter((ct) => ct.pillar_id === d.pillarId && (ct.active || ct.id === d.contentTypeId));
  const complete = !!(d.pillarId && d.contentTypeId && d.formatId && d.avatarId);

  async function add() {
    setBusy(true);
    try {
      await api(`/tasks/${task.id}/links`, {
        method: "POST",
        body: JSON.stringify({ links: pasted.map((p) => ({ platformId: p.platformId, url: links[p.platformId].trim() })), ...d }),
      });
      toast.success(`Added. It's live on ${pasted.map((p) => p.name).join(" and ")}.`);
      setLinks({});
      await onDone();
    } catch (e) {
      toast.error(errText(e, "Couldn't add those links."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open.map((p) => (
        <div className="sch-link" key={p.platformId}>
          {tileOf(p.key, p.name)}
          <input type="url" inputMode="url" placeholder={`Paste the ${p.name} link`} aria-label={`${p.name} link`}
            value={links[p.platformId] ?? ""} onChange={(e) => setLinks((l) => ({ ...l, [p.platformId]: e.target.value }))} />
        </div>
      ))}
      {pasted.length > 0 && (
        <div className="sch-details">
          <span className="sch-details-h">The post's details <small>for Analytics, as on Add Post</small></span>
          <div className="sch-grid">
            <label>Pillar
              <select value={d.pillarId} onChange={(e) => setD({ ...d, pillarId: e.target.value, contentTypeId: "" })}>
                <option value="">Pick…</option>
                {(tax?.pillars ?? []).filter((x) => x.active || x.id === d.pillarId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label>Content type
              <select value={d.contentTypeId} disabled={!d.pillarId} onChange={(e) => setD({ ...d, contentTypeId: e.target.value })}>
                <option value="">{d.pillarId ? "Pick…" : "Pick a pillar first"}</option>
                {types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label>Format
              <select value={d.formatId} onChange={(e) => setD({ ...d, formatId: e.target.value })}>
                <option value="">Pick…</option>
                {(tax?.formats ?? []).filter((x) => x.active || x.id === d.formatId).map((x) => (
                  <option key={x.id} value={x.id}>{x.name} · {x.post_type === "carousel" ? "Carousel" : "Reel"}</option>
                ))}
              </select>
            </label>
            <label>Avatar
              <select value={d.avatarId} onChange={(e) => setD({ ...d, avatarId: e.target.value })}>
                <option value="">Pick…</option>
                {(tax?.avatars ?? []).filter((x) => x.active || x.id === d.avatarId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !complete} onClick={add}>
            {busy ? "Adding…" : pasted.length === 1 ? "Add the link" : `Add ${pasted.length} links`}
          </button>
        </div>
      )}
    </>
  );
}
