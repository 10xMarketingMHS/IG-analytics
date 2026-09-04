import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { ensureBootstrapped } from "./bootstrap.js";
import { authRouter, requireAuth } from "./auth.js";
import { resolveWorkspace } from "./resolve-workspace.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { workspaceRouter } from "./routes/workspace.js";
import { postsRouter } from "./routes/posts.js";
import { taxonomyRouter } from "./routes/taxonomy.js";
import { editorsRouter } from "./routes/editors.js";
import { platformsRouter } from "./routes/platforms.js";
import { tasksRouter } from "./routes/tasks.js";
import { taskRulesRouter } from "./routes/task-rules.js";
import { contentFormatsRouter } from "./routes/content-formats.js";
import { usersRouter } from "./routes/users.js";
import { breaksRouter } from "./routes/breaks.js";
import { activityRouter } from "./routes/activity.js";
import { integrationsRouter } from "./routes/integrations.js";
import { goalsRouter } from "./routes/goals.js";
import { accessRouter } from "./routes/access.js";

const app = express();

// Render (and most hosts) terminate TLS at a proxy in front of the app. Trust
// it so Express knows the original request was HTTPS — required for `secure`
// session cookies to be set.
app.set("trust proxy", 1);

// In dev the frontend port can vary (auto-assigned), so reflect any origin.
// In production the frontend is same-origin, so CORS is effectively a no-op.
app.use(cors({ origin: config.NODE_ENV === "production" ? config.CORS_ORIGIN : true, credentials: true }));
app.use(express.json({ limit: "3mb" })); // headroom for editor image data URLs
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);

// Workspace list/create/rename — not scoped to a single workspace.
app.use("/api", requireAuth, workspacesRouter);

// All data routes are scoped to the active workspace (resolveWorkspace sets
// req.workspaceId from the X-Workspace-Id header).
app.use("/api", requireAuth, resolveWorkspace, workspaceRouter);
app.use("/api", requireAuth, resolveWorkspace, postsRouter);
app.use("/api", requireAuth, resolveWorkspace, taxonomyRouter);
app.use("/api", requireAuth, resolveWorkspace, editorsRouter);
app.use("/api", requireAuth, resolveWorkspace, platformsRouter);
app.use("/api", requireAuth, resolveWorkspace, tasksRouter);
app.use("/api", requireAuth, resolveWorkspace, taskRulesRouter);
app.use("/api", requireAuth, resolveWorkspace, contentFormatsRouter);
app.use("/api", requireAuth, resolveWorkspace, usersRouter);
app.use("/api", requireAuth, resolveWorkspace, breaksRouter);
app.use("/api", requireAuth, resolveWorkspace, activityRouter);
app.use("/api", requireAuth, resolveWorkspace, integrationsRouter);
app.use("/api", requireAuth, resolveWorkspace, goalsRouter);
app.use("/api", requireAuth, resolveWorkspace, accessRouter);

// In production this one service also serves the built React app, so the whole
// thing lives on a single origin (no cross-site cookie/CORS headaches). In dev
// the frontend is served by Vite on :3000, so we skip this.
if (config.NODE_ENV === "production") {
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../pulse-app/dist",
  );
  app.use(express.static(dist));
  // SPA fallback: any non-API GET returns index.html so client-side routing
  // (React Router) works on refresh/deep links.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// Start listening FIRST, then bootstrap — never block the health check on a DB
// query. Supabase's session pooler caps the whole project at 15 clients; during
// a rolling deploy the old instance still holds its connections, so a fresh
// instance can briefly fail to grab one. If we `await` a DB call before
// listen(), that new instance never answers /api/health and Render marks the
// whole deploy failed (EMAXCONNSESSION). Listening immediately lets the health
// check pass; bootstrap runs in the background and simply retries once the old
// instance drains and connections free up.
app.listen(config.PORT, () => {
  console.log(`Pulse API listening on http://localhost:${config.PORT}`);
});

async function bootstrapWithRetry(attempt = 1) {
  try {
    const workspaceId = await ensureBootstrapped();
    console.log(`Default workspace: ${workspaceId}`);
  } catch (err) {
    const delayMs = Math.min(30_000, 2_000 * attempt);
    console.error(`Bootstrap attempt ${attempt} failed (retrying in ${delayMs}ms):`, err.message);
    setTimeout(() => bootstrapWithRetry(attempt + 1), delayMs).unref();
  }
}
bootstrapWithRetry();
