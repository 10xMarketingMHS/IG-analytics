import "./async-errors.js"; // first: async route errors go to the error handler, never crash the server
import express from "express";
import compression from "compression";
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
import { schedulingRouter } from "./routes/scheduling.js";
import { adUploadsRouter } from "./routes/ad-uploads.js";
import { animusRouter } from "./routes/animus.js";
import { connectionsRouter } from "./routes/connections.js";
import { pageAccessRouter } from "./routes/page-access.js";
import { aboutRouter } from "./routes/about.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { adTeamsRouter } from "./routes/ad-teams.js";
import { adsPerformanceRouter } from "./routes/ads-performance.js";
import { handoverRouter } from "./routes/handover.js";
import { leaderboardRouter } from "./routes/leaderboard.js";
import { taskRulesRouter } from "./routes/task-rules.js";
import { contentFormatsRouter } from "./routes/content-formats.js";
import { usersRouter } from "./routes/users.js";
import { breaksRouter } from "./routes/breaks.js";
import { activityRouter } from "./routes/activity.js";
import { integrationsRouter } from "./routes/integrations.js";
import { goalsRouter } from "./routes/goals.js";
import { brandGoalsRouter } from "./routes/brand-goals.js";
import { goalTrackerRouter } from "./routes/goal-tracker.js";
import { eodRouter } from "./routes/eod.js";
import { sodRouter } from "./routes/sod.js";
import { managementPerformanceRouter } from "./routes/management-performance.js";
import { accessRouter } from "./routes/access.js";
import { chatRouter } from "./routes/chat.js";
import { orgRouter } from "./routes/org.js";
import { attendanceRouter } from "./routes/attendance.js";
import { inboxRouter } from "./routes/inbox.js";
import { leaveRouter } from "./routes/leave.js";
import { homeRouter } from "./routes/home.js";
import { startThinning } from "./post-history.js";

const app = express();

// Render (and most hosts) terminate TLS at a proxy in front of the app. Trust
// it so Express knows the original request was HTTPS — required for `secure`
// session cookies to be set.
app.set("trust proxy", 1);

// Safety headers on every answer: don't guess file types, don't let another
// site show Echo inside a frame (a click-trick), send only the site name on
// links out, no camera / microphone / location, and — when it's live, over
// HTTPS — always HTTPS from now on. No "X-Powered-By: Express" either.
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (config.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
});

// Everything sent is compressed (brotli or gzip, whichever the browser takes):
// the app's files and every API answer go out several times smaller — the
// hosting plan counts bandwidth. Not the chat's live stream (it must go out
// as it's written; it says no-transform too), nor anything under 1 KB.
app.use(compression({
  filter: (req, res) => !String(req.headers.accept || "").includes("text/event-stream") && compression.filter(req, res),
}));

// In dev the frontend port can vary (auto-assigned), so reflect any origin.
// In production the frontend is same-origin, so CORS is effectively a no-op.
app.use(cors({ origin: config.NODE_ENV === "production" ? config.CORS_ORIGIN : true, credentials: true }));
app.use(express.json({ limit: "3mb" })); // headroom for editor image data URLs
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
// Animus, server to server with its connection line — before the sign-in routes
app.use("/api/animus", animusRouter);

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
app.use("/api", requireAuth, resolveWorkspace, schedulingRouter);
app.use("/api", requireAuth, resolveWorkspace, adUploadsRouter);
app.use("/api", requireAuth, resolveWorkspace, connectionsRouter);
app.use("/api", requireAuth, resolveWorkspace, pageAccessRouter);
app.use("/api", requireAuth, resolveWorkspace, aboutRouter);
app.use("/api", requireAuth, resolveWorkspace, knowledgeRouter);
app.use("/api", requireAuth, resolveWorkspace, adTeamsRouter);
app.use("/api", requireAuth, resolveWorkspace, adsPerformanceRouter);
app.use("/api", requireAuth, resolveWorkspace, handoverRouter);
app.use("/api", requireAuth, resolveWorkspace, leaderboardRouter);
app.use("/api", requireAuth, resolveWorkspace, taskRulesRouter);
app.use("/api", requireAuth, resolveWorkspace, contentFormatsRouter);
app.use("/api", requireAuth, resolveWorkspace, usersRouter);
app.use("/api", requireAuth, resolveWorkspace, breaksRouter);
app.use("/api", requireAuth, resolveWorkspace, activityRouter);
app.use("/api", requireAuth, resolveWorkspace, integrationsRouter);
app.use("/api", requireAuth, resolveWorkspace, goalsRouter);
app.use("/api", requireAuth, resolveWorkspace, brandGoalsRouter);
app.use("/api", requireAuth, resolveWorkspace, goalTrackerRouter);
app.use("/api", requireAuth, resolveWorkspace, eodRouter);
app.use("/api", requireAuth, resolveWorkspace, sodRouter);
app.use("/api", requireAuth, resolveWorkspace, managementPerformanceRouter);
app.use("/api", requireAuth, resolveWorkspace, accessRouter);
app.use("/api", requireAuth, resolveWorkspace, chatRouter);
app.use("/api", requireAuth, resolveWorkspace, orgRouter);
app.use("/api", requireAuth, resolveWorkspace, attendanceRouter);
app.use("/api", requireAuth, resolveWorkspace, inboxRouter);
app.use("/api", requireAuth, resolveWorkspace, leaveRouter);
app.use("/api", requireAuth, resolveWorkspace, homeRouter);

// In production this one service also serves the built React app, so the whole
// thing lives on a single origin (no cross-site cookie/CORS headaches). In dev
// the frontend is served by Vite on :3000, so we skip this.
if (config.NODE_ENV === "production") {
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../pulse-app/dist",
  );
  // Browsers keep the built files in /assets for a year: each one's name
  // changes with its content, so a deploy brings new names, never stale code.
  // index.html is checked every time, so a deploy shows at once.
  app.use(express.static(dist, {
    setHeaders(res, file) {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));
  // SPA fallback: any non-API GET returns index.html so client-side routing
  // (React Router) works on refresh/deep links.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dist, "index.html"), { cacheControl: false, headers: { "Cache-Control": "no-cache" } });
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return res.end(); // part of an answer already went out
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
  console.log(`Echo API listening on http://localhost:${config.PORT}`);
});
// posts' day-by-day numbers: older than 90 days, thinned to one a week
startThinning();

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
