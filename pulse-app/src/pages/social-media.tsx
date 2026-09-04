import { useMemo, useState } from "react";
import { Loader } from "@/components/loader";
import { useResource } from "@/lib/use-resource";
import { useEditors } from "@/lib/use-editors";
import { useAuth } from "@/lib/auth-context";
import { noteTaskSeen } from "@/lib/use-task-notify";
import { api, ApiError } from "@/lib/api";
import { TaskModal } from "@/pages/tasks";
import { toast } from "sonner";
import type { Task, TaskStatus } from "@/lib/types";

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", review: "Review", done: "Done" };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Social Media tasks = every task with a linked post (auto-created when an
// editor is assigned to a post, or manually linked from the Task Board).
// Grouped by account (channel × platform) — the same lens as the Dashboard.
export function SocialMediaPage() {
  const { data, refetch } = useResource<{ tasks: Task[] }>("/tasks?socialMedia=1");
  const { editors } = useEditors();
  const { user } = useAuth();
  const tasks = data?.tasks ?? null;
  const [editing, setEditing] = useState<Task | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, { channel: string; platform: string; icon: string; tasks: Task[] }>();
    for (const t of tasks ?? []) {
      const channel = t.channel_name ?? "Unassigned channel";
      const platform = t.platform_name ?? "Unknown platform";
      const key = `${channel}·${platform}`;
      if (!map.has(key)) {
        map.set(key, { channel, platform, icon: platformIcon(t.platform_key), tasks: [] });
      }
      map.get(key)!.tasks.push(t);
    }
    return [...map.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.platform.localeCompare(b.platform));
  }, [tasks]);

  async function claim(t: Task) {
    if (!user?.editorId) {
      toast.error("Your account isn't linked to a team member — ask an admin under Settings.");
      return;
    }
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ editorId: user.editorId }) });
      toast.success(`Claimed "${t.title}".`);
      noteTaskSeen(user.id, t.id);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not claim that task.");
    }
  }

  return (
    <section className="screen">
      {tasks === null ? (
        <Loader label="Loading…" />
      ) : tasks.length === 0 ? (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13.5 }}>
          No Social Media tasks yet. These show up automatically when an editor is assigned to a post — or
          link an existing manual task to a post from its Task Board card.
        </div>
      ) : (
        groups.map((g) => (
          <div key={`${g.channel}·${g.platform}`} style={{ marginBottom: 24 }}>
            <div className="sectitle">
              <span className="dot" />
              <span className="mx-chan">{g.icon} {g.channel} · {g.platform}</span>
              <span className="s">{g.tasks.length} task{g.tasks.length === 1 ? "" : "s"}</span>
            </div>
            <div className="card pad">
              <div className="need-list">
                {g.tasks.map((t) => {
                  const overdue = t.status !== "done" && t.due_date && t.due_date < today();
                  return (
                    <div className="need-row" key={t.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(t); setModalOpen(true); }}>
                      {t.editor_image ? (
                        <img className="need-ava" src={t.editor_image} alt={t.editor_name ?? ""} />
                      ) : (
                        <span className="need-ava init">{(t.editor_name ?? "?").charAt(0).toUpperCase()}</span>
                      )}
                      <div className="need-main">
                        <div className="need-title">{t.title}</div>
                        <div className="need-meta">
                          <span className={"tdot " + t.status} style={{ display: "inline-block", marginRight: 5 }} />
                          {STATUS_LABEL[t.status]}
                          {t.editor_name ? ` · ${t.editor_name}` : " · Unclaimed"}
                        </div>
                      </div>
                      {!t.editor_id && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={(e) => { e.stopPropagation(); claim(t); }}
                        >
                          Claim
                        </button>
                      )}
                      {t.due_date && (
                        <span className={"need-due" + (overdue ? " over" : t.due_date === today() ? " today" : "")}>
                          {overdue ? "Overdue" : t.due_date === today() ? "Today" : t.due_date}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))
      )}

      {modalOpen && (
        <TaskModal
          task={editing}
          editors={editors ?? []}
          onClose={() => { setModalOpen(false); refetch(); }}
          onSaved={() => { setModalOpen(false); refetch(); }}
        />
      )}
    </section>
  );
}

function platformIcon(key: string | null) {
  if (key === "instagram") return "📷";
  if (key === "facebook") return "👍";
  if (key === "youtube") return "▶️";
  return "🌐";
}
