import { Router } from "express";
import fs from "node:fs";
import { pool } from "../db.js";
import { hasColumn } from "../schema-flags.js";

// Settings › About Echo: which version is running, when it went live, and who
// to ask for help or access.
//   GET /about   { version, commit, deployedAt, superAdmins: [name] }
// The version is server/package.json's, raised with each release (what's new
// in it: pulse-app/src/lib/whats-new.ts); commit is the one Render built
// (RENDER_GIT_COMMIT); deployedAt is when this server started.
const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const STARTED = new Date().toISOString();

export const aboutRouter = Router();

aboutRouter.get("/about", async (req, res, next) => {
  try {
    const withSuper = await hasColumn("app_user", "is_super_admin");
    const { rows } = withSuper
      ? await pool.query(
        `select coalesce(e.name, u.name, u.email) as name from app_user u left join editor e on e.id = u.editor_id
          where u.active and u.is_super_admin
            and exists (select 1 from membership m join workspace w on w.id = m.workspace_id where m.user_id = u.id and w.org_id = $1)
          order by 1`,
        [req.orgId],
      )
      : { rows: [] };
    res.json({
      version: pkg.version,
      commit: String(process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null,
      deployedAt: STARTED,
      superAdmins: rows.map((r) => r.name),
    });
  } catch (err) {
    next(err);
  }
});
