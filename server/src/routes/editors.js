import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAdmin } from "../resolve-workspace.js";
import { logActivity } from "../activity.js";
import { hasColumn } from "../schema-flags.js";
import { superState, isSuperUser } from "../super-admin.js";

export const editorsRouter = Router();

const EditorSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  // Small resized data URL (or "" to clear); downscaled client-side.
  imageUrl: z.string().max(2_000_000).optional(),
  // Company ID shown on the roster (e.g. MHS001); "" clears it.
  employeeCode: z.string().trim().max(20).optional(),
  // Counts in the Task Points rankings: false when a Super Admin switched them
  // out (say a Team Lead); null or true counts.
  inTaskScore: z.boolean().nullable().optional(),
  // The Team Lead this person reports to (Team › Roster); null for none.
  leadEditorId: z.string().uuid().nullable().optional(),
});

const BASE_COLUMNS = "id, name, designation, image_url, active";
// employee_code and in_task_score arrived with later database changes — read
// them once they're there.
const editorColumns = async () =>
  BASE_COLUMNS +
  ((await hasColumn("editor", "employee_code")) ? ", employee_code" : ", null::text as employee_code") +
  ((await hasColumn("editor", "in_task_score")) ? ", in_task_score" : ", null::boolean as in_task_score") +
  ((await hasColumn("editor", "lead_editor_id")) ? ", lead_editor_id" : ", null::uuid as lead_editor_id");
const codeOf = (v) => (v ? v.toUpperCase() : null);

// An admin's or Super Admin's roster record (position, employee code, name,
// photo, removal) is a Super Admin's to change — the position decides their
// Home and what they see. Someone may still change their own name and photo.
const SUPER_ONLY_RECORD = "Only a Super Admin can change an admin's details.";
async function adminOwner(editorId) {
  const { rows } = await pool.query(
    `select u.id from app_user u join membership m on m.user_id = u.id
      where u.editor_id = $1 and m.role = 'admin' limit 1`,
    [editorId],
  );
  return rows[0]?.id ?? null;
}
async function mayChangeRecord(req, editorId, fields) {
  const owner = await adminOwner(editorId);
  if (!owner) return true;
  if (await isSuperUser(req.user.sub, await superState(req.workspaceId))) return true;
  // Your own record: name and photo only.
  return owner === req.user.sub && fields.every((f) => f === "name" || f === "imageUrl");
}

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
  try {
    const fields = Object.keys(parsed.data).filter((k) => parsed.data[k] !== undefined);
    if (!(await mayChangeRecord(req, req.params.id, fields))) return res.status(403).json({ error: SUPER_ONLY_RECORD });
  } catch (err) {
    return next(err);
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
    if (parsed.data.inTaskScore !== undefined) {
      // Who counts in the Task Points rankings is the Super Admin's call.
      if (!(await isSuperUser(req.user.sub, await superState(req.workspaceId)))) {
        return res.status(403).json({ error: "Only a Super Admin can change who counts in the task score." });
      }
      if (!(await hasColumn("editor", "in_task_score"))) {
        return res.status(409).json({ error: "The task score switch needs a database update first — ask whoever runs the database to apply 20261024120000_task_score_flag." });
      }
      params.push(parsed.data.inTaskScore);
      sets.push(`in_task_score = $${params.length}`);
    }
    if (parsed.data.leadEditorId !== undefined) {
      if (!(await hasColumn("editor", "lead_editor_id"))) {
        return res.status(409).json({ error: "Team leads need a database update first — ask whoever runs the database to apply 20261025120000_attendance." });
      }
      if (parsed.data.leadEditorId === req.params.id) return res.status(400).json({ error: "Someone can't be their own team lead." });
      if (parsed.data.leadEditorId) {
        const { rows: l } = await pool.query("select 1 from editor where id = $1 and org_id = $2", [parsed.data.leadEditorId, req.orgId]);
        if (!l.length) return res.status(400).json({ error: "That team lead isn't on the team." });
      }
      params.push(parsed.data.leadEditorId);
      sets.push(`lead_editor_id = $${params.length}`);
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
    if (!(await mayChangeRecord(req, req.params.id, ["remove"]))) return res.status(403).json({ error: SUPER_ONLY_RECORD });
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
