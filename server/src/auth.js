import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { logActivity } from "./activity.js";
import { hasColumn } from "./schema-flags.js";

const COOKIE_NAME = "pulse_session";
const SESSION_TTL = "7d";
// While a Super Admin views Pulse as someone else, their own session waits
// here, and the borrowed one lasts at most two hours.
const REAL_COOKIE = "pulse_session_real";
const VIEW_AS_TTL_MS = 2 * 60 * 60 * 1000;
const READ_ONLY = "You're viewing Pulse as someone else, so it's read-only. Switch back to make changes.";

const cookieOpts = (maxAge) => ({
  httpOnly: true,
  // SameSite=None is required for a cross-origin frontend (e.g. Netlify
  // staging) to receive this cookie at all; it also requires Secure.
  sameSite: config.CROSS_ORIGIN_COOKIES ? "none" : "lax",
  secure: config.CROSS_ORIGIN_COOKIES || config.NODE_ENV === "production",
  maxAge,
});
const readToken = (token) => { try { return jwt.verify(token, config.JWT_SECRET); } catch { return null; } };

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post("/login", async (req, res, next) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid email and password." });
  }
  const { email, password } = parsed.data;

  try {
    const { rows } = await pool.query(
      "select id, email, password_hash, active, editor_id, name, image_url, color from app_user where lower(email) = lower($1)",
      [email],
    );
    const user = rows[0];
    // Compare against a dummy hash when the user is missing so timing doesn't
    // reveal whether the email exists.
    const hash = user?.password_hash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva";
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      return res.status(401).json({ error: "Invalid login credentials" });
    }
    if (!user.active) {
      return res.status(403).json({ error: "This account has been deactivated." });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      config.JWT_SECRET,
      { expiresIn: SESSION_TTL },
    );
    res.cookie(COOKIE_NAME, token, cookieOpts(7 * 24 * 60 * 60 * 1000));
    res.clearCookie(REAL_COOKIE);
    res.json({
      user: { id: user.id, email: user.email, editorId: user.editor_id, name: user.name, imageUrl: user.image_url, color: user.color },
    });
  } catch (err) {
    next(err);
  }
});

// "Forgot password?" — Pulse can't send email, so this tells the admin instead:
// a request lands in the activity feed of each team the login belongs to, and
// the admin sets a temporary password from Settings → Team. The answer is the
// same whether or not the email has a login, so it can't be used to probe for
// accounts; repeat requests within 10 minutes are ignored.
authRouter.post("/forgot", async (req, res, next) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!z.string().email().safeParse(email).success) {
    return res.status(400).json({ error: "Enter the email you sign in with." });
  }
  try {
    const { rows } = await pool.query(
      "select id, email, active from app_user where lower(email) = lower($1)",
      [email],
    );
    const u = rows[0];
    if (u && u.active) {
      const { rows: orgs } = await pool.query(
        `select distinct w.org_id from membership m join workspace w on w.id = m.workspace_id
          where m.user_id = $1`,
        [u.id],
      );
      for (const { org_id: orgId } of orgs) {
        const { rowCount } = await pool.query(
          `select 1 from activity where org_id = $1 and actor_id = $2 and verb = 'password_reset_requested'
              and created_at > now() - interval '10 minutes'`,
          [orgId, u.id],
        );
        if (rowCount) continue;
        await logActivity({
          orgId, actorId: u.id, verb: "password_reset_requested",
          entityType: "user", entityId: u.id,
          summary: "Asked for a password reset", meta: { email: u.email },
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.clearCookie(REAL_COOKIE);
  res.status(204).end();
});

// Super Admin "view as" (testing): open Pulse as the person with this
// employee code (Team › Roster), to see exactly what they see. Read-only —
// requireAuth refuses every change while it lasts — and logged in Activity.
// Only a real Super Admin (app_user.is_super_admin), never while already
// viewing as someone.
authRouter.post("/view-as", async (req, res, next) => {
  const me = readToken(req.cookies?.[COOKIE_NAME]);
  if (!me) return res.status(401).json({ error: "Not signed in" });
  if (me.actAs) return res.status(409).json({ error: "Switch back to yourself first." });
  const code = typeof req.body?.employeeCode === "string" ? req.body.employeeCode.trim() : "";
  if (!code) return res.status(400).json({ error: "Enter an employee code." });
  try {
    if (!(await hasColumn("app_user", "is_super_admin")) || !(await hasColumn("editor", "employee_code"))) {
      return res.status(409).json({ error: "View as needs the Super Admin database update first." });
    }
    const { rows: mine } = await pool.query("select is_super_admin, coalesce(name, email) as name from app_user where id = $1 and active", [me.sub]);
    if (!mine[0]?.is_super_admin) return res.status(403).json({ error: "Only a Super Admin can view Pulse as someone else." });
    const { rows } = await pool.query(
      `select u.id, u.email, u.active, coalesce(e.name, u.name, u.email) as name, e.org_id
         from editor e join app_user u on u.editor_id = e.id
        where upper(e.employee_code) = upper($1)
          and e.org_id in (select w.org_id from membership m join workspace w on w.id = m.workspace_id where m.user_id = $2)
        limit 1`,
      [code, me.sub],
    );
    const who = rows[0];
    if (!who) return res.status(404).json({ error: "No one with a login has that employee code." });
    if (who.id === me.sub) return res.status(409).json({ error: "That's your own code." });
    if (!who.active) return res.status(409).json({ error: `${who.name}'s login is deactivated.` });

    const borrowed = jwt.sign({ sub: who.id, email: who.email, actAs: me.sub }, config.JWT_SECRET, { expiresIn: VIEW_AS_TTL_MS / 1000 });
    res.cookie(REAL_COOKIE, req.cookies[COOKIE_NAME], cookieOpts(7 * 24 * 60 * 60 * 1000));
    res.cookie(COOKIE_NAME, borrowed, cookieOpts(VIEW_AS_TTL_MS));
    await logActivity({
      orgId: who.org_id, actorId: me.sub, verb: "view_as",
      entityType: "user", entityId: who.id,
      summary: `Viewed Pulse as ${who.name} (read-only test)`,
    }).catch(() => {});
    res.json({ viewingAs: { name: who.name } });
  } catch (err) {
    next(err);
  }
});

// Back to yourself: your own session returns; the borrowed one ends. If yours
// has expired meanwhile, both go and you sign in again.
authRouter.post("/view-as/stop", (req, res) => {
  const cur = readToken(req.cookies?.[COOKIE_NAME]);
  const real = readToken(req.cookies?.[REAL_COOKIE]);
  res.clearCookie(REAL_COOKIE);
  if (real && (!cur || !cur.actAs || cur.actAs === real.sub)) {
    res.cookie(COOKIE_NAME, req.cookies[REAL_COOKIE], cookieOpts(7 * 24 * 60 * 60 * 1000));
    return res.json({ ok: true });
  }
  res.clearCookie(COOKIE_NAME);
  res.status(401).json({ error: "Your own session has ended — sign in again." });
});

authRouter.get("/me", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    // editor_id (and profile fields, which the user can change themselves)
    // can change after login, so they're looked up fresh rather than trusted
    // from the token, which only ever carries id + email.
    const withPrefs = await hasColumn("app_user", "notify_prefs");
    const withSuper = await hasColumn("app_user", "is_super_admin");
    const { rows } = await pool.query(
      `select editor_id, name, image_url, color${withPrefs ? ", notify_prefs" : ""}${withSuper ? ", is_super_admin" : ""} from app_user where id = $1`,
      [payload.sub],
    );
    const u = rows[0];
    // Viewing as someone (Super Admin test mode): who is really signed in.
    const real = payload.actAs
      ? (await pool.query("select coalesce(name, email) as name from app_user where id = $1", [payload.actAs])).rows[0]
      : null;
    res.json({
      user: {
        id: payload.sub, email: payload.email, editorId: u?.editor_id ?? null, name: u?.name ?? null, imageUrl: u?.image_url ?? null, color: u?.color ?? null,
        // Which in-app alerts they get (Settings › Notifications); a missing key is on.
        notifyPrefs: u?.notify_prefs ?? {},
        isSuperAdmin: !!u?.is_super_admin,
        viewingAs: payload.actAs ? { id: payload.actAs, name: real?.name ?? "you" } : null,
      },
    });
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
});

export function requireAuth(req, res, next) {
  // mounted with every router (index.js): checked once per request
  if (req.user) return next();
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.user = jwt.verify(token, config.JWT_SECRET);
    // Viewing as someone is look-only: nothing may change under their name.
    if (req.user.actAs && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return res.status(403).json({ error: READ_ONLY, readOnly: true });
    }
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}
