import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// A main type with sub-types (Settings › Tasks & time, routes/content-formats.js)
// is only a heading: goals, brand goals and new tasks go on its sub-types. What's
// already on it stays: a task keeps its type, and a goal saved before it had
// sub-types can stay as it is or come down, but not go up.

// Of these type ids, the ones that are headings: id -> name.
export async function headingTypes(orgId, ids) {
  const list = ids.filter(Boolean);
  if (!list.length || !(await hasColumn("task_content_format", "parent_id"))) return new Map();
  const { rows } = await pool.query(
    `select p.id, p.name from task_content_format p
      where p.org_id = $1 and p.id = any($2::uuid[])
        and exists (select 1 from task_content_format s where s.parent_id = p.id and s.active)`,
    [orgId, list],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const headingError = (name) => `${name} has sub-types, so it's only a heading. Pick one of them instead.`;

// Its points, time and switches are its sub-types' too (Settings › Tasks & time
// shows their totals). What it keeps of its own: its name, icon and category.
export const headingFieldError = (name) => `${name} has sub-types, so it's only a heading. Set this on its sub-types instead.`;

// What a task of this type can't be, as words to say; null when it can.
export async function taskTypeError(orgId, contentFormatId) {
  const name = (await headingTypes(orgId, [contentFormatId])).get(contentFormatId);
  return name ? headingError(name) : null;
}

// The main type a sub-type sits under, or null.
export async function parentTypeOf(contentFormatId) {
  if (!contentFormatId || !(await hasColumn("task_content_format", "parent_id"))) return null;
  const { rows } = await pool.query("select parent_id from task_content_format where id = $1", [contentFormatId]);
  return rows[0]?.parent_id ?? null;
}

// For a query's WHERE, on a type aliased `alias`: leaves out headings (copying
// last month's goals). Empty before the database has sub-types.
export async function notHeadingSql(alias) {
  return (await hasColumn("task_content_format", "parent_id"))
    ? ` and not exists (select 1 from task_content_format s where s.parent_id = ${alias}.id and s.active)`
    : "";
}
