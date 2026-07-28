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
import { usersRouter } from "./routes/users.js";
import { activityRouter } from "./routes/activity.js";

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
app.use("/api", requireAuth, resolveWorkspace, usersRouter);
app.use("/api", requireAuth, resolveWorkspace, activityRouter);

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

const workspaceId = await ensureBootstrapped();

app.listen(config.PORT, () => {
  console.log(`Pulse API listening on http://localhost:${config.PORT}`);
  console.log(`Default workspace: ${workspaceId}`);
});
