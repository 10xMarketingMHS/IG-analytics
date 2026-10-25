import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission } from "../permissions.js";
import { isSuperHere } from "../super-admin.js";
import { hasColumn } from "../schema-flags.js";
import { followTypeTick } from "../scheduling.js";

// What a type is worth is the Super Admin's call; an admin adds, renames and
// times types, and sees their points.
const POINTS_SUPER_ONLY = "Only a Super Admin can change a task type's points.";

export const contentFormatsRouter = Router();

const Schema = z.object({
  name: z.string().trim().min(1).max(40),
  icon: z.string().trim().min(1).max(8).optional(),
  // Which category (Social vs Ads) this content type belongs to — a format
  // lives in exactly one, and the task-creation dropdown pulls the chosen
  // category's list. Required on create; can be changed later — tasks already
  // made keep the category they were made with.
  category: z.enum(["social", "ad", "service", "project"]).optional(),
  // Points Formula base_points for this format — how much a task in it is
  // worth before the on-time/late timing multiplier applies. Independent of
  // budget_hours (task-rules.js) — a format's point value and its time
  // budget are two separate admin decisions.
  points: z.number().nonnegative().max(1000).optional(),
  // Management-metric tag: mark a format as a Key or Critical Metric so
  // Management Performance can report goal-vs-achieved against it. null clears.
  metric_tier: z.enum(["key", "critical"]).nullable().optional(),
  // Project-type-only (category='project'): duration bounds a project's Due
  // Date; metrics_description is free-form documentation ONLY — no scoring
  // logic reads it. Ignored for the other categories.
  duration_days: z.number().int().positive().max(3650).nullable().optional(),
  metrics_description: z.string().max(2000).nullable().optional(),
  // Must a task of this type have a delivery link before going to review?
  review_link_required: z.boolean().optional(),
  // Does an approved Social task of this type go to Scheduling (its post date,
  // then its links — ../scheduling.js)? Reels, Carousel, Post: yes; Thumbnail: no.
  to_scheduling: z.boolean().optional(),
});

const SELECT = "id, name, icon, sort_order, active, points, category, metric_tier, duration_days, metrics_description, review_link_required";
// to_scheduling comes with the scheduling database update (20261104120000_task_scheduling)
const schedCol = () => hasColumn("task_content_format", "to_scheduling");
const select = async () => SELECT + ((await schedCol()) ? ", to_scheduling" : "");
const CATEGORIES = ["social", "ad", "service", "project"];

// Org-wide, like editors — every channel picks from the same list.
contentFormatsRouter.get("/content-formats", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${await select()} from task_content_format where org_id = $1 and active order by sort_order, name`,
      [req.orgId],
    );
    res.json({ contentFormats: rows });
  } catch (err) {
    next(err);
  }
});

contentFormatsRouter.post("/content-formats", requirePermission("task_settings"), async (req, res, next) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the format a name." });
  const category = parsed.data.category;
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Pick a category (Social, Ads, Service or Project) for this content type." });
  }
  try {
    if (parsed.data.points != null && Number(parsed.data.points) !== 1 && !(await isSuperHere(req))) {
      return res.status(403).json({ error: POINTS_SUPER_ONLY });
    }
    // Sort order is per category, so each list numbers from 1 independently.
    const { rows: maxRow } = await pool.query(
      "select coalesce(max(sort_order), 0) + 1 as n from task_content_format where org_id = $1 and category = $2",
      [req.orgId, category],
    );
    // a new Social type goes to Scheduling unless it's unticked (most Social work is posted)
    const sched = await schedCol();
    const { rows } = await pool.query(
      `insert into task_content_format
         (org_id, name, icon, sort_order, category, metric_tier, points, duration_days, metrics_description${sched ? ", to_scheduling" : ""})
       values ($1, $2, $3, $4, $5, $6, coalesce($7, 1), $8, $9${sched ? ", $10" : ""}) returning ${await select()}`,
      [req.orgId, parsed.data.name, parsed.data.icon || "🔧", maxRow[0].n, category,
       parsed.data.metric_tier ?? null, parsed.data.points ?? null,
       parsed.data.duration_days ?? null, parsed.data.metrics_description ?? null,
       ...(sched ? [parsed.data.to_scheduling ?? category === "social"] : [])],
    );
    res.status(201).json({ contentFormat: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That format already exists." });
    next(err);
  }
});

contentFormatsRouter.patch("/content-formats/:id", requirePermission("task_settings"), async (req, res, next) => {
  const parsed = Schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update." });
  const sets = [];
  const vals = [];
  if (parsed.data.name !== undefined) { vals.push(parsed.data.name); sets.push(`name = $${vals.length}`); }
  if (parsed.data.icon !== undefined) { vals.push(parsed.data.icon); sets.push(`icon = $${vals.length}`); }
  if (parsed.data.category !== undefined) { vals.push(parsed.data.category); sets.push(`category = $${vals.length}`); }
  if (parsed.data.points !== undefined) { vals.push(parsed.data.points); sets.push(`points = $${vals.length}`); }
  if (parsed.data.metric_tier !== undefined) { vals.push(parsed.data.metric_tier); sets.push(`metric_tier = $${vals.length}`); }
  if (parsed.data.duration_days !== undefined) { vals.push(parsed.data.duration_days); sets.push(`duration_days = $${vals.length}`); }
  if (parsed.data.metrics_description !== undefined) { vals.push(parsed.data.metrics_description); sets.push(`metrics_description = $${vals.length}`); }
  if (parsed.data.review_link_required !== undefined) { vals.push(parsed.data.review_link_required); sets.push(`review_link_required = $${vals.length}`); }
  const tick = parsed.data.to_scheduling;
  if (tick !== undefined) {
    if (!(await schedCol())) return res.status(409).json({ error: "Scheduling needs a database update first — ask whoever runs the database to apply 20261104120000_task_scheduling." });
    vals.push(tick); sets.push(`to_scheduling = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  vals.push(req.params.id, req.orgId);
  try {
    if (parsed.data.points !== undefined) {
      const { rows: cur } = await pool.query("select points from task_content_format where id = $1 and org_id = $2", [req.params.id, req.orgId]);
      if (cur[0] && Number(cur[0].points) !== Number(parsed.data.points) && !(await isSuperHere(req))) {
        return res.status(403).json({ error: POINTS_SUPER_ONLY });
      }
    }
    const { rows: was } = tick !== undefined
      ? await pool.query("select to_scheduling from task_content_format where id = $1 and org_id = $2", [req.params.id, req.orgId]) : { rows: [] };
    const { rows } = await pool.query(
      `update task_content_format set ${sets.join(", ")}
       where id = $${vals.length - 1} and org_id = $${vals.length} returning ${await select()}`,
      vals,
    );
    if (!rows.length) return res.status(404).json({ error: "Format not found." });
    // the Scheduling list follows the tick: how many tasks came in or went out
    const moved = was[0] && was[0].to_scheduling !== tick ? await followTypeTick(req.orgId, req.params.id, tick) : 0;
    res.json({ contentFormat: rows[0], ...(tick !== undefined ? { schedulingMoved: moved } : {}) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That format already exists." });
    next(err);
  }
});

// Soft-delete — tasks and rules already using it keep displaying correctly
// (name/icon still resolve); it just stops being offered for new ones.
contentFormatsRouter.delete("/content-formats/:id", requirePermission("task_settings"), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "update task_content_format set active = false where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "Format not found." });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
