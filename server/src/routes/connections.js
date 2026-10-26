import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { taskViewer } from "../hierarchy.js";
import { connectionsReady, newSecret, secretHash, tokenOf } from "../connections.js";

// Settings › Connected apps (../connections.js): the Managers (and Asst.
// Managers) by position, and the Super Admin, make a connection for one brand —
// its line is shown once — see each one's last use, and revoke it.
//   GET    /connections        the connections, and the brands to connect
//   POST   /connections        { brandId, label } → { connection, token } (the token only this once)
//   DELETE /connections/:id    revoke it
export const connectionsRouter = Router();

const NEEDS_DB = "Connected apps needs a database update first — ask whoever runs the database to apply 20261106120000_ad_uploads.";
const NOT_MANAGER = "Connected apps is for the Managers and the Super Admin.";
const mayManage = async (req) => { const v = await taskViewer(req); return v.seesAll || v.rank <= 1; };

const SELECT = `select c.id, c.app, c.label, c.workspace_id as "brandId", w.name as "brandName", c.created_at as "createdAt",
                       coalesce(e.name, u.email) as "createdByName", c.last_used_at as "lastUsedAt", c.revoked_at as "revokedAt"
                  from app_connection c join workspace w on w.id = c.workspace_id
                  left join app_user u on u.id = c.created_by left join editor e on e.id = u.editor_id`;

connectionsRouter.get("/connections", async (req, res, next) => {
  try {
    if (!(await connectionsReady())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayManage(req))) return res.status(403).json({ error: NOT_MANAGER });
    const [{ rows: connections }, { rows: brands }] = await Promise.all([
      pool.query(`${SELECT} where c.org_id = $1 order by c.revoked_at nulls first, c.created_at desc`, [req.orgId]),
      pool.query("select id, name from workspace where org_id = $1 order by name", [req.orgId]),
    ]);
    res.json({ connections, brands });
  } catch (err) { next(err); }
});

const NewSchema = z.object({
  brandId: z.string({ required_error: "Pick the brand it connects to." }).uuid("Pick the brand it connects to."),
  label: z.string().trim().max(60, "Keep the name under 60 characters.").optional(),
});

connectionsRouter.post("/connections", async (req, res, next) => {
  const parsed = NewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That couldn't be read." });
  try {
    if (!(await connectionsReady())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayManage(req))) return res.status(403).json({ error: NOT_MANAGER });
    const { rows: [brand] } = await pool.query("select id from workspace where id = $1 and org_id = $2", [parsed.data.brandId, req.orgId]);
    if (!brand) return res.status(400).json({ error: "Pick the brand it connects to." });
    const secret = newSecret();
    const { rows: [made] } = await pool.query(
      `insert into app_connection (org_id, workspace_id, app, label, secret_hash, created_by)
       values ($1, $2, 'animus', $3, $4, $5) returning id`,
      [req.orgId, brand.id, parsed.data.label ?? "", secretHash(secret), req.user.sub],
    );
    const { rows: [connection] } = await pool.query(`${SELECT} where c.id = $1`, [made.id]);
    // the only time the secret leaves Echo
    res.status(201).json({ connection, token: tokenOf(made.id, secret) });
  } catch (err) { next(err); }
});

connectionsRouter.delete("/connections/:id", async (req, res, next) => {
  try {
    if (!(await connectionsReady())) return res.status(409).json({ error: NEEDS_DB });
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
