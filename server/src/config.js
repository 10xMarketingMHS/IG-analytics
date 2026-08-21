import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(1),
  ADMIN_USER_ID: z.string().uuid(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(4000),
  // Same-origin in production (frontend is served by this server), so CORS is a
  // no-op there. Only matters in dev where Vite (:3000) calls the API (:4000).
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  // Set to "true" only when the frontend is on a different domain than this
  // API (e.g. Netlify frontend + Render backend, for a staging split-deploy).
  // The session cookie needs SameSite=None to survive a real cross-site
  // fetch — SameSite=Lax (the same-origin default) is silently dropped by
  // the browser on cross-origin requests, which breaks login with no error.
  CROSS_ORIGIN_COOKIES: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // --- Integrations (all optional; features stay dormant until set) ---
  // Public origin of this deployment, used to build OAuth redirect URIs.
  // e.g. https://ig-analytics.onrender.com  (dev: http://localhost:4000)
  APP_BASE_URL: z.string().url().optional(),
  // 32-byte key (hex or base64) used to encrypt stored access tokens at rest.
  APP_ENCRYPTION_KEY: z.string().optional(),
  // Meta (Facebook/Instagram Graph API) app credentials.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // A long-lived Meta System User token. When set, accounts can be connected
  // with one click (no OAuth) and the token never expires — the simplest path
  // when you own the assets in a verified Business portfolio.
  META_SYSTEM_TOKEN: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
