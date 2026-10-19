import { useEffect, useMemo, useState } from "react";
import { Loader } from "@/components/loader";
import { useResource } from "@/lib/use-resource";
import { markActivitySeen } from "@/lib/activity-seen";
import { useTasks } from "@/lib/use-tasks";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { TaskPanel } from "@/pages/tasks";
import type { Activity, ActivityVerb } from "@/lib/types";

// Icon + tone per event kind, so the feed reads at a glance.
const VERB_META: Record<ActivityVerb, { icon: string; cls: string }> = {
  created: { icon: "✅", cls: "v-task" },
  completed: { icon: "🎉", cls: "v-done" },
  assigned: { icon: "👤", cls: "v-task" },
  commented: { icon: "💬", cls: "v-comment" },
  published: { icon: "🚀", cls: "v-post" },
  stage_completed: { icon: "🎬", cls: "v-post" },
  channel_added: { icon: "🌐", cls: "v-channel" },
  editor_added: { icon: "🧑‍🎨", cls: "v-editor" },
  review_requested: { icon: "👀", cls: "v-task" },
  sent_back: { icon: "↩️", cls: "v-task" },
  reopened: { icon: "🔄", cls: "v-task" },
  deleted: { icon: "🗑️", cls: "v-task" },
  held: { icon: "⏸️", cls: "v-task" },
  resumed: { icon: "▶️", cls: "v-task" },
  password_reset_requested: { icon: "🔑", cls: "v-editor" },
  password_reset: { icon: "🔑", cls: "v-editor" },
  sod_submitted: { icon: "📝", cls: "v-editor" },
  attendance_check_in: { icon: "☀️", cls: "v-editor" },
  attendance_no_sod: { icon: "⏰", cls: "v-editor" },
  attendance_nudge: { icon: "👋", cls: "v-editor" },
  attendance_marked: { icon: "📋", cls: "v-editor" },
  attendance_excused: { icon: "✅", cls: "v-editor" },
  attendance_undone: { icon: "↩️", cls: "v-editor" },
  attendance_correction: { icon: "🕘", cls: "v-editor" },
  attendance_correction_answered: { icon: "🕘", cls: "v-editor" },
};

function relTime(iso: string) {
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

// Human day bucket for grouping headers.
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yday = new Date();
  yday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function ActivityPage() {
  const { data, loading } = useResource<{ activity: Activity[] }>("/activity?limit=120");
  const items = data?.activity ?? [];
  const [filter, setFilter] = useState<"all" | "tasks" | "posts">("all");
  // An entry about a task opens that task's details right here — the feed is
  // where people learn something changed, so it shouldn't be a dead end.
  const { tasks, refetch: refetchTasks } = useTasks();
  const { editors } = useEditors();
  const { workspaces, active } = useWorkspaces();
  const taskById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  const [openId, setOpenId] = useState<string | null>(null);
  const openTask = openId ? taskById.get(openId) ?? null : null;

  // Opening the feed clears the topbar bell's unread badge.
  useEffect(() => {
    if (items.length) markActivitySeen(items[0].created_at);
  }, [items]);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "tasks") return items.filter((a) => a.entity_type === "task");
    return items.filter((a) => a.entity_type === "post" || a.entity_type === "channel");
  }, [items, filter]);

  // Group consecutive items by day.
  const groups = useMemo(() => {
    const out: { label: string; rows: Activity[] }[] = [];
    for (const a of filtered) {
      const label = dayLabel(a.created_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(a);
      else out.push({ label, rows: [a] });
    }
    return out;
  }, [filtered]);

  return (
    <section className="screen eod-open">
      <div className="act-toolbar">
        <div className="seg">
          {(["all", "tasks", "posts"] as const).map((f) => (
            <button key={f} className={"seg-btn" + (filter === f ? " on" : "")} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "tasks" ? "Tasks" : "Content"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Loader label="Loading activity…" />
      ) : groups.length === 0 ? (
        <div className="card pad home-empty">🔔 No activity yet — updates on your tasks and the team will show up here.</div>
      ) : (
        <div className="act-feed">
          {groups.map((g) => (
            <div key={g.label} className="act-group">
              <div className="act-daylabel">{g.label}</div>
              <div className="card act-card">
                {g.rows.map((a) => {
                  const m = VERB_META[a.verb] ?? { icon: "•", cls: "" };
                  // Only tasks that still exist (and that this person can see) open.
                  const task = a.entity_type === "task" && a.entity_id ? taskById.get(a.entity_id) : undefined;
                  const note = a.verb === "sent_back" && typeof a.meta?.note === "string" ? a.meta.note : null;
                  return (
                    <div
                      key={a.id}
                      className={"act-row" + (task ? " act-link" : "")}
                      role={task ? "button" : undefined}
                      tabIndex={task ? 0 : undefined}
                      title={task ? "Open this task" : undefined}
                      onClick={task ? () => setOpenId(task.id) : undefined}
                      onKeyDown={task ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(task.id); } } : undefined}
                    >
                      <span className={"act-icon " + m.cls}>{m.icon}</span>
                      <div className="act-main">
                        <div className="act-text">
                          <span className="act-actor">{a.actor_name ?? "Someone"}</span> {a.summary}
                        </div>
                        {note && <div className="act-note">“{note}”</div>}
                        <div className="act-meta">
                          {a.channel_name && <span className="act-chip">{a.channel_name}</span>}
                          <span className="act-time">{relTime(a.created_at)}</span>
                          {task && <span className="act-open">Open ›</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {openTask && (
        <TaskPanel
          mode="edit" task={openTask} canWrite={active?.role !== "viewer"} editors={editors ?? []} channels={workspaces ?? []}
          onClose={() => setOpenId(null)}
          onChanged={refetchTasks}
          onCreated={() => {}}
        />
      )}
    </section>
  );
}
