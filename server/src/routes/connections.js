import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { taskViewer } from "../hierarchy.js";
import { connectionsReady, newSecret, secretHash, tokenOf } from "../connections.js";
import { adTeamsReady } from "../ad-uploads.js";

// Settings › Connected apps (../connections.js): the Managers (and Asst.
// Managers) by position, and the Super Admin, make a connection for one Ads
// team — its line is shown once — see each one's last use, and revoke it.
//   GET    /connections        the connections, and the Ads teams to connect
//   POST   /connections        { teamId, label } → { connection, token } (the token only this once)
//   DELETE /connections/:id    revoke it
export const connectionsRouter = Router();

const NEEDS_DB = "Connected apps needs a database update first — ask whoever runs the database to apply 20261106120000_ad_uploads.";
const NOT_MANAGER = "Connected apps is for the Managers and the Super Admin.";
const mayManage = async (req) => { const v = await taskViewer(req); return v.seesAll || v.rank <= 1; };

const SELECT = `select c.id, c.app, c.label, coalesce(c.ad_team_id, c.workspace_id) as "teamId", coalesce(tm.name, w.name) as "teamName",
                       c.created_at as "createdAt", coalesce(e.name, u.email) as "createdByName", c.last_used_at as "lastUsedAt", c.revoked_at as "revokedAt"
                  from app_connection c left join ad_team tm on tm.id = c.ad_team_id left join workspace w on w.id = c.workspace_id
                  left join app_user u on u.id = c.created_by left join editor e on e.id = u.editor_id`;
const ready = async () => (await connectionsReady()) && adTeamsReady();

connectionsRouter.get("/connections", async (req, res, next) => {
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayManage(req))) return res.status(403).json({ error: NOT_MANAGER });
    const [{ rows: connections }, { rows: teams }] = await Promise.all([
      pool.query(`${SELECT} where c.org_id = $1 order by c.revoked_at nulls first, c.created_at desc`, [req.orgId]),
      pool.query("select id, name, lead_name as \"leadName\" from ad_team where org_id = $1 and active order by sort_order, lower(name)", [req.orgId]),
    ]);
    res.json({ connections, teams });
  } catch (err) { next(err); }
});

const NewSchema = z.object({
  teamId: z.string({ required_error: "Pick the Ads team it connects to." }).uuid("Pick the Ads team it connects to."),
  label: z.string().trim().max(60, "Keep the name under 60 characters.").optional(),
});

connectionsRouter.post("/connections", async (req, res, next) => {
  const parsed = NewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayManage(req))) return res.status(403).json({ error: NOT_MANAGER });
    const { rows: [team] } = await pool.query("select id from ad_team where id = $1 and org_id = $2 and active", [parsed.data.teamId, req.orgId]);
    if (!team) return res.status(400).json({ error: "Pick the Ads team it connects to." });
    const secret = newSecret();
    const { rows: [made] } = await pool.query(
      `insert into app_connection (org_id, ad_team_id, app, label, secret_hash, created_by)
       values ($1, $2, 'animus', $3, $4, $5) returning id`,
      [req.orgId, team.id, parsed.data.label ?? "", secretHash(secret), req.user.sub],
    );
    const { rows: [connection] } = await pool.query(`${SELECT} where c.id = $1`, [made.id]);
    // the only time the secret leaves Echo
    res.status(201).json({ connection, token: tokenOf(made.id, secret) });
  } catch (err) { next(err); }
});

connectionsRouter.delete("/connections/:id", async (req, res, next) => {
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayManage(req))) return res.status(403).json({ error: NOT_MANAGER });
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "No such connection." });
    const { rowCount } = await pool.query(
      "update app_connection set revoked_at = coalesce(revoked_at, now()) where id = $1 and org_id = $2",
      [req.params.id, req.orgId],
    );
    if (!rowCount) return res.status(404).json({ error: "No such connection." });
    const { rows: [connection] } = await pool.query(`${SELECT} where c.id = $1`, [req.params.id]);
    res.json({ connection });
  } catch (err) { next(err); }
});
