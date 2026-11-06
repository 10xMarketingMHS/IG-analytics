import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { logActivity } from "../activity.js";
import { hasColumn } from "../schema-flags.js";
import {
  PAGES, ROWS, callerAccess, defaultRow, editableRows, forgetGrid, fullRow, gridOf, pageByKey, rowByKey, rowOf, tidyRow,
} from "../page-access.js";

// Settings › Page access (../page-access.js): the grid of positions against
// pages, each with a See and a Change tick.
//   GET    /page-access            the grid, who's in each row, which rows you may set
//   PUT    /page-access/rows/:row  { pages: { [page]: { see, change } } } — save a row
//   DELETE /page-access/rows/:row  back to today's rules for that row
//   GET    /page-access/me         your own row's ticks (pages null: today's rules hold)
// The Super Admin sets every row; an admin only the rows below their own
// position, and only with ticks their own row has.
export const pageAccessRouter = Router();

const NOT_FOR_YOU = "Page access is for the Super Admin and the admins.";

pageAccessRouter.get("/page-access/me", async (req, res, next) => {
  try {
    const a = await callerAccess(req);
    res.json({ super: a.super, row: a.row, saved: a.saved, pages: a.pages });
  } catch (err) { next(err); }
});

pageAccessRouter.get("/page-access", async (req, res, next) => {
  try {
    const a = await callerAccess(req);
    if (!a.super && !a.admin) return res.status(403).json({ error: NOT_FOR_YOU });
    const withSuper = await hasColumn("app_user", "is_super_admin");
    const [grid, { rows: people }] = await Promise.all([
      gridOf(req.orgId),
      pool.query(
        `select e.name, e.designation,
                exists (select 1 from app_user u join membership m on m.user_id = u.id join workspace w on w.id = m.workspace_id
                         where u.editor_id = e.id and m.role = 'admin' and w.org_id = $1) as admin,
                ${withSuper ? "exists (select 1 from app_user u where u.editor_id = e.id and u.is_super_admin)" : "false"} as super
           from editor e where e.org_id = $1 and coalesce(e.active, true) order by lower(e.name)`,
        [req.orgId],
      ),
    ]);
    const by = [...new Set(Object.values(grid).map((g) => g?.savedBy).filter(Boolean))];
    const names = by.length
      ? new Map((await pool.query("select u.id, coalesce(e.name, u.name, u.email) as name from app_user u left join editor e on e.id = u.editor_id where u.id = any($1::uuid[])", [by])).rows.map((x) => [x.id, x.name]))
      : new Map();
    res.json({
      pages: PAGES.map(({ def, ...p }) => p),
      rows: ROWS.map((r) => {
        const g = grid[r.key];
        return {
          ...r,
          people: people.filter((p) => rowOf(p.designation, p.admin) === r.key).map((p) => ({ name: p.name, admin: p.admin, super: p.super })),
          saved: !!g, savedAt: g?.savedAt ?? null, savedByName: g ? names.get(g.savedBy) ?? null : null,
          pages: g ? tidyRow(g.pages) : defaultRow(r.key),
        };
      }),
      me: { super: a.super, row: a.row },
      editable: editableRows(a),
      // what an admin may give: their own row's ticks (today's rules: an admin's — everything but the Super Admin's own)
      own: a.super ? null : a.pages ?? fullRow(),
    });
  } catch (err) { next(err); }
});

const RowSchema = z.object({
  pages: z.record(z.string(), z.object({ see: z.boolean().optional(), change: z.boolean().optional() })),
});

// May the caller set this row? (a 403 answer, or null)
function refuse(a, row) {
  if (!row) return [404, "No such position."];
  if (editableRows(a).includes(row.key)) return null;
  return [403, a.admin ? "You can set only the positions below your own." : NOT_FOR_YOU];
}

pageAccessRouter.put("/page-access/rows/:row", async (req, res, next) => {
  const parsed = RowSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Send the row's ticks." });
  try {
    const a = await callerAccess(req);
    const row = rowByKey(req.params.row);
    const no = refuse(a, row);
    if (no) return res.status(no[0]).json({ error: no[1] });
    const pages = tidyRow(parsed.data.pages);
    // an admin gives only what their own row has
    if (!a.super) {
      const own = a.pages ?? fullRow();
      const over = Object.entries(pages).find(([k, t]) => (t.see && !own[k].see) || (t.change && !own[k].change));
      if (over) {
        const p = pageByKey(over[0]);
        return res.status(403).json({ error: `You can give only what your own position has — not ${over[1].change && !own[over[0]].change ? "changing" : "seeing"} ${p.group === p.label ? p.label : `${p.group} › ${p.label}`}.` });
      }
    }
    const entry = { pages, savedAt: new Date().toISOString(), savedBy: req.user.sub };
    await pool.query(
      `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{pageAccess}',
         jsonb_build_object('rows', coalesce(settings->'pageAccess'->'rows', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)), true)
        where id = $1`,
      [req.orgId, row.key, JSON.stringify(entry)],
    );
    forgetGrid(req.orgId);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "page_access_set", entityType: "org", entityId: req.orgId,
      summary: `Set what ${row.label}s can see and change`, meta: { row: row.key },
    });
    res.json({ row: { key: row.key, saved: true, savedAt: entry.savedAt, pages } });
  } catch (err) { next(err); }
});

pageAccessRouter.delete("/page-access/rows/:row", async (req, res, next) => {
  try {
    const a = await callerAccess(req);
    const row = rowByKey(req.params.row);
    const no = refuse(a, row);
    if (no) return res.status(no[0]).json({ error: no[1] });
    await pool.query(
      `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{pageAccess}',
         jsonb_build_object('rows', coalesce(settings->'pageAccess'->'rows', '{}'::jsonb) - $2::text), true)
        where id = $1`,
      [req.orgId, row.key],
    );
    forgetGrid(req.orgId);
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "page_access_reset", entityType: "org", entityId: req.orgId,
      summary: `Put ${row.label}s back on today's access rules`, meta: { row: row.key },
    });
    res.json({ row: { key: row.key, saved: false, pages: defaultRow(row.key) } });
  } catch (err) { next(err); }
});
