import { Router } from "express";
import { clearSettingsCache } from "../attendance.js";
import { z } from "zod";
import { pool } from "../db.js";
import { hasColumn } from "../schema-flags.js";
import { isOrgAdmin } from "../permissions.js";

// Home layouts: each person's own Home (widgets in order with their size, and
// whether the banner shows) per Home role, and the defaults an admin publishes
// for a role (org.settings.homeDefaults). The widget catalog and the built-in
// defaults live in the app (pulse-app/src/lib/home-widgets.ts).
export const homeRouter = Router();

const ROLE = z.enum(["manager", "lead", "editor"]);
const WIDGET = z.tuple([z.string().regex(/^[a-z]{2,16}$/), z.number().int().min(1).max(3)]);
const LAYOUT = z.array(WIDGET).max(24);
const NEEDS_DB = "Saving your Home needs a database update first — ask whoever runs the database to apply 20261025120000_attendance.";

async function defaultsOf(orgId) {
  if (!(await hasColumn("org", "settings"))) return {};
  const { rows } = await pool.query("select settings->'homeDefaults' as d from org where id = $1", [orgId]);
  return rows[0]?.d ?? {};
}

// GET /home/layout — your saved layouts (by role) and the published defaults.
homeRouter.get("/home/layout", async (req, res, next) => {
  try {
    const mine = {};
    if (await hasColumn("home_layout", "layout")) {
      const { rows } = await pool.query("select role, layout, banner from home_layout where user_id = $1", [req.user.sub]);
      for (const r of rows) mine[r.role] = { layout: r.layout, banner: r.banner };
    }
    res.json({ mine, defaults: await defaultsOf(req.orgId) });
  } catch (err) { next(err); }
});

// PUT /home/layout { role, layout, banner } — save your own.
homeRouter.put("/home/layout", async (req, res, next) => {
  const parsed = z.object({ role: ROLE, layout: LAYOUT, banner: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That layout couldn't be read." });
  try {
    if (!(await hasColumn("home_layout", "layout"))) return res.status(409).json({ error: NEEDS_DB });
    const { role, layout, banner } = parsed.data;
    await pool.query(
      `insert into home_layout (user_id, role, layout, banner) values ($1, $2, $3::jsonb, $4)
       on conflict (user_id, role) do update set layout = excluded.layout, banner = excluded.banner, updated_at = now()`,
      [req.user.sub, role, JSON.stringify(layout), banner],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /home/layout?role= — Reset: back to the role's default.
homeRouter.delete("/home/layout", async (req, res, next) => {
  const parsed = ROLE.safeParse(req.query.role);
  if (!parsed.success) return res.status(400).json({ error: "Which Home?" });
  try {
    if (await hasColumn("home_layout", "layout")) {
      await pool.query("delete from home_layout where user_id = $1 and role = $2", [req.user.sub, parsed.data]);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /home/default { role, layout } — Admin / Super Admin: publish a layout as
// the role's default. People who already customised keep theirs; Reset brings
// them to the new default.
homeRouter.put("/home/default", async (req, res, next) => {
  const parsed = z.object({ role: ROLE, layout: LAYOUT }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "That layout couldn't be read." });
  try {
    if (!(req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub)))) {
      return res.status(403).json({ error: "Only an admin can set the default Home." });
    }
    if (!(await hasColumn("org", "settings"))) return res.status(409).json({ error: NEEDS_DB });
    await pool.query(
      `update org set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{homeDefaults}',
         coalesce(settings->'homeDefaults', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)) where id = $1`,
      [req.orgId, parsed.data.role, JSON.stringify(parsed.data.layout)],
    );
    clearSettingsCache(req.orgId);
    res.json({ defaults: await defaultsOf(req.orgId) });
  } catch (err) { next(err); }
});
