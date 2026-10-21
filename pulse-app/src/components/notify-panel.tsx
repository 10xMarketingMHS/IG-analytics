import { useEffect, useRef } from "react";
import { VERB_META, relTime } from "@/lib/activity-meta";
import type { Activity } from "@/lib/types";

// The bell's box (like Facebook's): the latest notices, newest first, the
// unread ones marked. A notice about a task opens it; See all opens the full
// Activity page. Closes on a click outside or Escape.
export function NotifyPanel({ items, seenBefore, onClose, onSeeAll, onOpenTask, anchor }: {
  items: Activity[] | undefined;
  // what was already read when the box opened (opening it marks the rest read)
  seenBefore: string;
  onClose: () => void;
  onSeeAll: () => void;
  onOpenTask: (taskId: string) => void;
  // the bell itself: a click on it toggles, so it doesn't count as outside
  anchor: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc); };
  }, [onClose, anchor]);

  const list = (items ?? []).slice(0, 8);
  return (
    <div className="nt-pop" ref={ref} role="dialog" aria-label="Notifications">
      <div className="nt-head">
        <b>Notifications</b>
        <button type="button" className="nt-all" onClick={onSeeAll}>See all</button>
      </div>
      {list.length === 0 ? (
        <div className="nt-empty">Nothing yet. Updates on your tasks and the team show up here.</div>
      ) : (
        <ul className="nt-list">
          {list.map((a) => {
            const m = VERB_META[a.verb] ?? { icon: "🔔", cls: "" };
            const unread = !seenBefore || a.created_at > seenBefore;
            const task = a.entity_type === "task" && a.entity_id ? a.entity_id : null;
            const body = (
              <>
                <span className={"nt-icon act-icon " + m.cls}>{m.icon}</span>
                <span className="nt-main">
                  <span className="nt-text">{a.actor_name && <b>{a.actor_name} </b>}{a.summary}</span>
                  <span className="nt-time">{relTime(a.created_at)}{a.channel_name ? ` · ${a.channel_name}` : ""}</span>
                </span>
                {unread && <span className="nt-dot" aria-label="New" />}
              </>
            );
            return (
              <li key={a.id}>
                {task ? (
                  <button type="button" className={"nt-row" + (unread ? " unread" : "")} onClick={() => onOpenTask(task)} title="Open this task">{body}</button>
                ) : (
                  <div className={"nt-row" + (unread ? " unread" : "")}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="nt-more" onClick={onSeeAll}>See all activity</button>
    </div>
  );
}
