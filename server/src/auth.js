import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { logActivity } from "./activity.js";
import { hasColumn } from "./schema-flags.js";
import { attemptLimiter } from "./attempts.js";

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
  password: z.string().min(1).max(200),
});

// Wrong passwords: 8 for one email from one address, or 40 from one address,
// within 15 minutes, then a wait. Forgot password: 3 asks for one email, or 10
// from one address, an hour.
const logins = attemptLimiter({ windowMs: 15 * 60_000, perEmail: 8, perAddress: 40 });
const forgots = attemptLimiter({ windowMs: 60 * 60_000, perEmail: 3, perAddress: 10 });
const addressOf = (req) => req.ip || req.socket?.remoteAddress || "?";
const tooMany = (res, minutes, what) =>
  res.status(429).json({ error: `Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
// A real bcrypt hash (same cost as stored ones) to check a password against
// when the email has no login, so the answer takes as long either way and
// doesn't show which emails exist.
const NO_LOGIN_HASH = bcrypt.hashSync("pulse-no-such-login", 10);

export const authRouter = Router();

authRouter.post("/login", async (req, res, next) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid email and password." });
  }
  const { email, password } = parsed.data;
  const ip = addressOf(req);
  const wait = logins.wait(ip, email);
  if (wait) return tooMany(res, wait, "sign-in attempts");

  try {
    const { rows } = await pool.query(
      "select id, email, password_hash, active, editor_id, name, image_url, color from app_user where lower(email) = lower($1)",
      [email],
    );
    const user = rows[0];
    // No login with that email: still a full password check, so the answer
    // takes as long and doesn't reveal whether the email exists.
    const ok = await bcrypt.compare(password, user?.password_hash ?? NO_LOGIN_HASH);

    if (!user || !ok) {
      logins.count(ip, email);
      return res.status(401).json({ error: "Invalid login credentials" });
    }
    logins.clear(ip, email);
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
  const ip = addressOf(req);
  const wait = forgots.wait(ip, email);
  if (wait) return tooMany(res, wait, "requests");
  forgots.count(ip, email);
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
    // your own session is kept only as long as the borrowed one lasts
    res.cookie(REAL_COOKIE, req.cookies[COOKIE_NAME], cookieOpts(VIEW_AS_TTL_MS));
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

// Back to yourself: your own session returns; the borrowed one ends. Only from
// a borrowed session that's still live and was started from that same session:
// once it has expired (someone else at that browser later), or with anyone
// else's sign-in, both go and you sign in again.
authRouter.post("/view-as/stop", (req, res) => {
  const cur = readToken(req.cookies?.[COOKIE_NAME]);
  const real = readToken(req.cookies?.[REAL_COOKIE]);
  res.clearCookie(REAL_COOKIE);
  if (real && cur?.actAs && cur.actAs === real.sub) {
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
    if (!u || !(await isActiveLogin(payload.sub))) return res.status(401).json({ error: SWITCHED_OFF });
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

// A switched-off login stops working at once, not when its cookie runs out:
// every request checks, and the answer is kept a few seconds. Switching a login
// off or on (routes/users.js) forgets it straight away.
const activeCache = new Map(); // userId -> { ok, exp }
const ACTIVE_TTL_MS = 15_000;
export function forgetActive(userId) {
  if (userId) activeCache.delete(userId); else activeCache.clear();
}
export async function isActiveLogin(userId) {
  const hit = activeCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.ok;
  const { rows } = await pool.query("select active from app_user where id = $1", [userId]);
  const ok = !!rows[0]?.active;
  activeCache.set(userId, { ok, exp: Date.now() + ACTIVE_TTL_MS });
  return ok;
}
const SWITCHED_OFF = "This login has been switched off. Ask an admin if that's a mistake.";
// The login behind a "view as" session: still switched on and still a Super Admin.
async function stillSuper(userId) {
  const { rows } = await pool.query("select active, is_super_admin from app_user where id = $1", [userId]);
  return !!rows[0]?.active && !!rows[0]?.is_super_admin;
}

export async function requireAuth(req, res, next) {
  // mounted with every router (index.js): checked once per request
  if (req.user) return next();
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in" });
  let user;
  try {
    user = jwt.verify(token, config.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Session expired" });
  }
  try {
    if (!(await isActiveLogin(user.sub))) return res.status(401).json({ error: SWITCHED_OFF });
    // viewing as someone: only while the Super Admin who started it still is one
    if (user.actAs && !(await stillSuper(user.actAs))) return res.status(401).json({ error: "View as has ended. Sign in again." });
  } catch (err) {
    return next(err);
  }
  req.user = user;
  // Viewing as someone is look-only: nothing may change under their name.
  if (req.user.actAs && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return res.status(403).json({ error: READ_ONLY, readOnly: true });
  }
  next();
}
