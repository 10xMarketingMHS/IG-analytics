import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";
import { logActivity } from "../activity.js";
import { hasColumn } from "../schema-flags.js";

export const editorsRouter = Router();

const EditorSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  // Small resized data URL (or "" to clear); downscaled client-side.
  imageUrl: z.string().max(2_000_000).optional(),
  // Company ID shown on the roster (e.g. MHS001); "" clears it.
  employeeCode: z.string().trim().max(20).optional(),
});

const BASE_COLUMNS = "id, name, designation, image_url, active";
// employee_code arrived with a later database change — read it once it's there.
const editorColumns = async () =>
  BASE_COLUMNS + ((await hasColumn("editor", "employee_code")) ? ", employee_code" : ", null::text as employee_code");
const codeOf = (v) => (v ? v.toUpperCase() : null);

// Editors are the shared Media House team — scoped to the org, so every channel
// sees the same people.
editorsRouter.get("/editors", async (req, res, next) => {
  try {
    // is_admin: this editor is linked to a user who holds an admin role
    // somewhere in the org. Used to keep admins out of "assign an editor"
    // pickers (they oversee; they aren't assigned editing work).
    const { rows } = await pool.query(
      `select ${await editorColumns()},
              exists(
                select 1 from app_user u
                join membership m on m.user_id = u.id
                where u.editor_id = e.id and m.role = 'admin'
              ) as is_admin
         from editor e where e.org_id = $1 order by name`,
      [req.orgId],
    );
    res.json({ editors: rows });
  } catch (err) {
    next(err);
  }
});

editorsRouter.post("/editors", requireAdmin, async (req, res, next) => {
  const parsed = EditorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  try {
    // workspace_id stays populated (NOT NULL) with the active channel for
    // history, but org_id is what scopes the shared team.
    const withCode = parsed.data.employeeCode !== undefined && (await hasColumn("editor", "employee_code"));
    const { rows } = await pool.query(
      `insert into editor (workspace_id, org_id, name, designation, image_url${withCode ? ", employee_code" : ""})
       values ($1, $2, $3, $4, $5${withCode ? ", $6" : ""})
       returning ${await editorColumns()}`,
      [
        req.workspaceId,
        req.orgId,
        parsed.data.name,
        parsed.data.designation ?? "",
        parsed.data.imageUrl || null,
        ...(withCode ? [codeOf(parsed.data.employeeCode)] : []),
      ],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "editor_added",
      entityType: "editor", entityId: rows[0].id, channelId: req.workspaceId,
      summary: `Added ${rows[0].name} to the team`,
    });
    res.status(201).json({ editor: rows[0] });
  } catch (err) {
    next(err);
  }
});

editorsRouter.patch("/editors/:id", requireAdmin, async (req, res, next) => {
  const parsed = EditorSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const sets = [];
  const params = [req.params.id, req.orgId];
  for (const [key, col] of [["name", "name"], ["designation", "designation"], ["imageUrl", "image_url"]]) {
    if (parsed.data[key] === undefined) continue;
    params.push(key === "imageUrl" ? parsed.data[key] || null : parsed.data[key]);
    sets.push(`${col} = $${params.length}`);
  }
  try {
    if (parsed.data.employeeCode !== undefined) {
      if (!(await hasColumn("editor", "employee_code"))) {
        return res.status(409).json({ error: "Employee codes need a database update first — ask whoever runs the database to apply 20261022120000_super_admin_employee_code." });
      }
      params.push(codeOf(parsed.data.employeeCode));
      sets.push(`employee_code = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    const { rows } = await pool.query(
      `update editor set ${sets.join(", ")}
       where id = $1 and org_id = $2
       returning ${await editorColumns()}`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: "Editor not found" });
    res.json({ editor: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Remove an editor. Posts they edited keep their history — post.editor_id is
// ON DELETE SET NULL, so those posts simply become unassigned.
editorsRouter.delete("/editors/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "delete from editor where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Editor not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
