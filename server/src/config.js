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
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
