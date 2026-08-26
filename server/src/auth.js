import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";

const COOKIE_NAME = "pulse_session";
const SESSION_TTL = "7d";

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
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      // SameSite=None is required for a cross-origin frontend (e.g. Netlify
      // staging) to receive this cookie at all; it also requires Secure.
      sameSite: config.CROSS_ORIGIN_COOKIES ? "none" : "lax",
      secure: config.CROSS_ORIGIN_COOKIES || config.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({
      user: { id: user.id, email: user.email, editorId: user.editor_id, name: user.name, imageUrl: user.image_url, color: user.color },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
});

authRouter.get("/me", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    // editor_id (and profile fields, which the user can change themselves)
    // can change after login, so they're looked up fresh rather than trusted
    // from the token, which only ever carries id + email.
    const { rows } = await pool.query(
      "select editor_id, name, image_url, color from app_user where id = $1",
      [payload.sub],
    );
    const u = rows[0];
    res.json({
      user: { id: payload.sub, email: payload.email, editorId: u?.editor_id ?? null, name: u?.name ?? null, imageUrl: u?.image_url ?? null, color: u?.color ?? null },
    });
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
});

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.user = jwt.verify(token, config.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}
