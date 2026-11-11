import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Each task type's checklist (Settings › Tasks & time › Checklist): the steps
// every new task of the type starts with, as ten checks for Reels. A task's
// items from its type are marked from_type: whoever does the task ticks them
// but can't remove or rename them (routes/tasks.js). Every item on a task is
// ticked before the work goes to Review. 20261117120000_type_checklist

export const CHECKLIST_MAX = 30;
export const CHECKLIST_ITEM_MAX = 300;
export const NEEDS_CHECKLIST = "Checklists need a database update first — ask whoever runs the database to apply 20261117120000_type_checklist.";

export async function typeChecklistReady() {
  return (await hasColumn("task_content_format", "checklist")) && (await hasColumn("subtask", "from_type"));
}

// A type's list as saved: each item trimmed, blanks and repeats dropped, in the order given.
export function cleanChecklist(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list ?? []) {
    const t = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

// Give a task its type's checklist, above anything added by hand, unless it has
// it already. Returns how many items it got. The type's steps are numbered
// below 0 (-999, -998, …) and steps added by hand from 1 up (routes/tasks.js),
// so the type's always come first.
export async function fillTypeChecklist(taskId, db = pool) {
  if (!taskId || !(await typeChecklistReady())) return 0;
  const { rowCount } = await db.query(
    `insert into subtask (task_id, title, sort_order, from_type)
     select t.id, x.title, x.n::int - 1000, true
       from task t
       join task_content_format f on f.id = t.content_format_id
       cross join lateral jsonb_array_elements_text(f.checklist) with ordinality as x(title, n)
      where t.id = $1
        and not exists (select 1 from subtask s where s.task_id = t.id and s.from_type)`,
    [taskId],
  );
  return rowCount;
}

// The task's type changed before it was handed in: the old type's items go and
// the new type's come in. Items added by hand stay.
export async function swapTypeChecklist(taskId, db = pool) {
  if (!taskId || !(await typeChecklistReady())) return;
  await db.query("delete from subtask where task_id = $1 and from_type", [taskId]);
  await fillTypeChecklist(taskId, db);
}

// How many of a task's checklist items are still open, and how many it has.
export async function openChecklist(taskId, db = pool) {
  const { rows } = await db.query(
    "select count(*)::int as total, (count(*) filter (where not done))::int as open from subtask where task_id = $1",
    [taskId],
  );
  return rows[0] ?? { total: 0, open: 0 };
}
