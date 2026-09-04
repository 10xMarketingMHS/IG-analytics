# Pulse — Status & Product Requirements (PRD)

**Product:** Pulse — a content-analytics + team-operations platform for **Media House** (the DF Foods / Doctor Farmer marketing team).
**As of:** 2026-09-02 · **Live commit:** `8d2707f` (== `origin/main`) · **Repo:** github.com/10xMarketingMHS/IG-analytics
**Deploy:** single Render web service, auto-deploys from `main`.

> Grounded in the current `main`: 42 migrations, 13 backend route modules, 3 platform integrations, 20 frontend pages, ~70 API endpoints. Where something is built-but-unproven-in-prod it says so.

---

## 1. Product overview

Pulse runs the Media House content operation end to end in one internal app:

1. **Track** content across brand channels and platforms (Instagram / Facebook / YouTube).
2. **Analyze** performance — dashboards, insights, trends, per-platform best content, format analytics.
3. **Operate** — a task board with timers, an editing pipeline, breaks, an activity feed, and editor leaderboards.
4. **Sync** live platform metrics (IG / FB / YT) instead of manual entry.

**Shape of the world:** one org (**Media House**) → many **Channels** (brands, e.g. Doctor Farmer, MyHealthSchool) → each on one or more **Platforms** → a **shared team of editors** → **Posts** (with metrics) and **Tasks**.

---

## 2. Current status — what's LIVE

Deployed on Render, auto-deploying from `main`. Everything below is on `main` and deployed.

### Foundation
- **Auth:** JWT in an httpOnly cookie, bcrypt, env-bootstrapped admin. Roles: **admin / editor / viewer**.
- **Single org** (Media House). Channels are workspaces under it; editors are shared org-wide.
- **Design system:** purple glassmorphism, light + dark themes, responsive, wide layout.

### Channels & Platforms *(Settings → Channels & Integrations)*
- Dense per-channel table: search, per-platform status, posts count, row-expander management. Add / inline-rename / delete channels (delete cascades posts + platform links + connections, keeps the shared team, refuses the last channel).
- Three independent platform connections per channel — **Instagram**, **Facebook**, **YouTube** — each with Connect / Disconnect · connected account name · status · last-synced · Sync. In-app YouTube API key (admin-set, encrypted). Admin-only across create/connect/disconnect/edit/delete.
- ⚠ Connections are shipped but only function once `APP_ENCRYPTION_KEY` + Meta/YouTube credentials are set on Render; not yet exercised end-to-end in prod with real tokens.

### Platform sync
- **Instagram:** views, reach, likes, comments, shares, saves — matched by post permalink, refresh-only.
- **YouTube:** views / likes / comments per video + subscribers, via the in-app org key.
- **Facebook (Option 2):** likes (all reactions collapsed), comments, shares, Page followers — views/reach intentionally blank (Meta deprecated the impression metrics).

### Posts *(Manage → Posts / Add Post)*
- Cross-channel content database; combinable multi-filters (Status · Format · Platform · Channel · Collabs-only), date-range, search, customizable columns.
- Channel-grouped Add-Post cards, bulk save; per-row platform, date, title, Link, Collab (IG-only), pillar→type→format cascade, post type, avatar, editor, status. Assigning an editor auto-creates a task.
- **Collab mirror:** a collab post creates an owner + a mirror on the collaborating channel; sync copies metrics to the mirror; mirrors excluded from aggregates.

### Taxonomy *(per channel; Settings)*
- **Pillar (P#) → Content Type (T#)** nesting with permanent per-scope serials; **Format (F#)** is channel-wide. Serials never renumber on delete.

### Task management *(Task Board)*
- **Board · List · Calendar** views; **My Tasks / Team** scope; filters (Overdue / Today / Tomorrow / This week; task type; format); search by TID/SID/AdID/title.
- **Statuses:** To Do → In Progress → Review → Completed, plus an **admin Hold** flag (task stays In Progress, shows a Hold badge, timer pauses).
- **Transitions:** assignee moves todo→in_progress→review; only admin resolves a review (approve→done, or send back with a note); **no In Progress → To Do** (admin parks with Hold instead).
- **Category-first creation:** every board task is **Social** or **Ads**; the Content Type dropdown lists that category's admin-configured types (picking one auto-sets the category). New tasks always start in **To Do**; only **admins** can assign to someone else (everyone else self-assigns).
- **Per-brand IDs:** every task has an internal **TID**; Social tasks get a per-brand **SID**, Ads tasks a per-brand **AID** (each brand numbers independently).
- **Time budgets & timer:** a task's budget is snapshotted from admin rules at creation; timer pauses on Review / Hold / break and resumes where it left off. Assignee must **accept** an assigned task before its clock starts.
- Drag-and-drop between columns; overdue badge; checklist/subtasks with progress; comments; review history; recurring tasks (daily/weekly auto-spawn).

### Task Settings *(Settings → Task Settings)*
- Content formats are **category-scoped** (a **Social / Ads toggle**): each category has its own content types, each with **points** (Points-Formula base value) and an optional **time budget**, plus **per-person time-budget overrides**.

### Breaks
- Shared daily break budget (75 min = lunch 45 + two 15-min teas). Starting a break pauses all the editor's running task timers at once; **can be ended at any time** (no minimum). Bottom-right widget on the Task Board, and a **full-screen "It's Break Time!" overlay** (3D steaming cup, countdown ring, live MM:SS, quote) that appears instantly when a break starts and auto-closes when it ends.

### Analytics
- **Dashboard / Insights / Trends / Top Performers / Reports / Format Analytics** — per-platform KPIs, auto-insights, 12-week/12-month time-series + IG/FB/YT comparison, best content per platform, format breakdowns, exports.
- **Editor Leaderboard:** Social Media Leaders (content Performance Score), Media House Leaders (Task Points), and **Progress Path** — an animated rank-over-time bump chart with month filter, daily resolution, content-points and task-completion modes.

### My Day *(home)*
- Personalized greeting; attention strip (Overdue / Due today / Awaiting metrics / In review); Needs-action list; editing-progress pipeline; this-month analytics; best post; a **gamified "your rank/score"** widget (Task Points). Task cards are **scoped to the logged-in user** (see §9 note).

### Operations & misc
- Editing Pipeline (post stages) on the Social & Ads Pipeline page; activity feed + 🔔 unread bell; My Profile (avatar picker); admin user management; Teams page.

---

## 3. System architecture

| Layer | Tech / detail |
|-------|---------------|
| Frontend | Vite + React 19 + TypeScript SPA, React Router, Recharts (code-split), @dnd-kit, sonner. 20 pages, context providers for auth / workspaces / break / theme. |
| Backend | Node / Express; JWT (httpOnly cookie), bcryptjs, `pg`, zod validation. 13 route modules. |
| Database | Supabase Postgres (Sydney) used as plain Postgres (no RLS/Auth in app). Pooler capped at 15 clients; app pool sized to fit rolling deploys. 42 migrations in `pulse-app/supabase/migrations/`, applied via `server/scripts/apply-migration.js` (stop backend first). |
| Hosting | **One** Render web service — Express serves the built React app → single origin, no CORS in prod. Singapore region. Auto-deploy from GitHub `main`. |
| Secrets (Render env) | DB URL, JWT secret, admin creds; `APP_ENCRYPTION_KEY` (AES-256-GCM for stored tokens + in-app YouTube key), `META_SYSTEM_TOKEN`, `META_APP_ID/SECRET`, `APP_BASE_URL`. YouTube Data API key is stored **in-app** (encrypted DB column), not env. |

### Data model (core tables)
`org` → `workspace` (channel/brand) → `account` (channel×platform) / `editor` (org-shared) → `post` → `task` → `subtask` / `task_comment`.
Plus: `platform` , `platform_connection` (encrypted tokens + `follower_count`), `app_user` (login, role, editor link), `activity` (event log), taxonomy (`pillar` / `content_type` / `format` / `avatar` with permanent serials via `taxonomy_seq`), `task_content_format` (category-scoped, points), `task_time_rule` (budget global + per-editor), `task_ref_seq` / `task_brand_ref_seq` (TID org-wide, SID/AID per brand), `task_review_log`.
Key task columns: `status`, `task_type`, `tid/sid/ad_id`, `content_format_id`, `budget_hours/budget_started_at/budget_used_seconds`, `accepted`, `on_hold`, `revision`, `pending_note`, `recurrence`. `editor` carries break state (`break_started_at/used_seconds/date`). `org` carries `youtube_api_key_enc` and `task_seq`.

---

## 4. Roles & permissions (requirements)

- **Admin:** everything — manage channels/platforms/connections, taxonomy, content formats & time rules, users; create/assign/hold/resolve tasks; approve or send-back reviews.
- **Editor:** create tasks (self-assign only), move their own tasks forward (todo→in_progress→review), accept/work/complete, manage posts, run syncs. Cannot assign to others, cannot move In Progress → To Do, cannot resolve reviews, cannot hold.
- **Viewer:** read-only (server 403s writes; UI hides write controls).
- Enforcement is **server-side** on every mutating route (`requireAdmin` / `requireEditor` / assignee checks); the UI mirrors it for affordance only.

---

## 5. Functional requirements (PRD core)

Each module lists **Frontend (FE)** and **Backend (BE)** requirements.

### 5.1 Auth & users
- **FE:** login screen; protected routes redirect to login; role-aware nav/controls; My Profile (name, avatar). Admin user-management screen.
- **BE:** cookie-session login/logout; bcrypt; `GET/POST/PATCH/DELETE /users`, `PATCH /users/me`; env-bootstrapped first admin; link an app-user to an editor roster record (drives "self" scoping and break tracking).

### 5.2 Channels (brands) & platforms
- **FE:** dense channel table with search + status filter + posts count; add/rename/delete; per-channel platform rows with Connect/Disconnect/Sync/status; platform pill locked when posts exist; admin-only gating everywhere.
- **BE:** `GET/POST/PATCH/DELETE /workspaces` (admin for mutations), `GET/POST/DELETE /accounts` (channel×platform), `GET /platforms`; delete cascades posts/links/connections, refuses last channel; 409 when toggling off a platform that has posts.

### 5.3 Taxonomy
- **FE:** per-channel management of pillars → content types (nested) and channel-wide formats + avatars; numeric serial display (P#/T#/F#); pickers sorted by serial.
- **BE:** `GET /taxonomy`; `POST/DELETE` for `pillars`, `content-types`, `formats`, `avatars`; permanent per-scope serials that never renumber on delete.

### 5.4 Content formats & task rules (points + time budgets)
- **FE (Task Settings):** Social/Ads **toggle**; per-category table of content types with icon, editable name, **points**, **time budget**; add/remove; **per-person overrides** grid (blank = inherit global).
- **BE:** `GET/POST/PATCH/DELETE /content-formats` (category required on create; uniqueness per (org, category, name)); `GET/POST/DELETE /task-time-rules` (global default per (org, format) + per-editor override); `GET /scoring-config`.

### 5.5 Posts (content database)
- **FE:** cross-channel table with combinable multi-filters, date-range, search, customizable/reorderable columns; channel-grouped Add-Post (bulk); single-post edit; collab (IG-only) selection.
- **BE:** `GET/POST/PATCH/DELETE /posts`; assigning an editor auto-creates a task; collab creates owner + mirror (`collab_group_id`, `is_collab_mirror`); mirrors excluded from aggregates and never sync independently.

### 5.6 Platform integrations & sync
- **FE:** connect flows per platform (system token / paste token / OAuth for Meta; URL/handle for YouTube); in-app YouTube key entry (admin); Sync buttons; status + last-synced.
- **BE:** `integrations.js` + `integrations/{instagram,facebook,youtube}.js`. Endpoints: IG connect-system / connect-token / OAuth callback / sync; FB connect-system / connect-token / sync (Option-2 metrics); YouTube connect / key (set/delete, validated) / sync; `GET /integrations/connections`, `GET /integrations/status`. Tokens AES-256-GCM encrypted; sync is refresh-only, matched by permalink/video-id. Shared-Meta auto-save (connecting IG also saves its linked FB Page).
- **Requirement/caveat:** functions only with the right Render env + real tokens; scheduled/auto sync and IG auto-import are **not** built (on-demand only).

### 5.7 Task management
- **FE:** Board/List/Calendar; My Tasks/Team scope; filters + search; category-first create card (Social/Ads → Project → Content Type; no Platforms; always To Do; admin-only Assign); Content Type dropdown from category's configured types (auto-sets category); drag-and-drop; overdue badge; Hold/Resume (admin); accept flow; checklist; comments; review history; recurring toggle. Display shows TID + SID/AID, content-format name, timer state.
- **BE (`tasks.js`):** `GET /tasks` (+ filters incl. `assignee=me`); `POST /tasks` (per-brand SID/AID assignment, Project required for social/ad, status forced sensibly); `PATCH /tasks/:id` (status gate: assignee-only forward, admin-only review resolve, block in_progress→todo, freeze held tasks, Hold/Resume with timer pause/resume); `POST /tasks/:id/accept` (starts/resumes timer); subtasks & comments & reviews endpoints; `spawnNextOccurrence` for recurring; TID/SID/AID via `next_task_ref` / `next_brand_task_ref`.

### 5.8 Breaks
- **FE:** bottom-right widget (Task Board only) start/stop; full-screen overlay on break start (shared break state so it's instant), dismissible, auto-close at 0:00.
- **BE (`breaks.js`):** `GET /break/status`, `POST /break/start`, `POST /break/end`; 75-min daily cap; **no minimum duration**; auto-expiry at cap; a break offsets every running task timer for that editor (computed, not per-task writes).

### 5.9 Analytics & scoring
- **FE:** Dashboard / Insights / Trends / Top Performers / Reports / Format Analytics; Leaderboard (3 boards incl. animated Progress Path).
- **BE:** derived from `GET /posts` and `GET /tasks` + `GET /scoring-config`; **two formulas** (see §7).

### 5.10 Activity feed, notifications, My Day
- **FE:** activity page + topbar 🔔 unread bell (localStorage last-seen); My Day home (attention strip, needs-action, pipeline, this-month analytics, best post, gamified rank).
- **BE:** `GET /activity`; events logged from task/post/channel/editor mutations.

---

## 6. API surface (current)

**Auth/Users:** `POST/GET/PATCH/DELETE /users`, `PATCH /users/me`.
**Workspaces/Accounts/Platforms:** `GET/POST/PATCH/DELETE /workspaces`, `GET /workspace`, `GET/POST/DELETE /accounts`, `GET /platforms`.
**Taxonomy:** `GET /taxonomy`; `POST/DELETE /pillars|/content-types|/formats|/avatars`.
**Content formats & rules:** `GET/POST/PATCH/DELETE /content-formats`, `GET/POST/DELETE /task-time-rules`, `GET /scoring-config`.
**Posts:** `GET/POST/PATCH/DELETE /posts`, `GET /posts/:id`.
**Tasks:** `GET/POST /tasks`, `PATCH/DELETE /tasks/:id`, `POST /tasks/:id/accept`, `GET/POST /tasks/:id/comments`, `GET/POST /tasks/:id/subtasks`, `PATCH/DELETE /subtasks/:id`, `GET /tasks/:id/reviews`.
**Breaks:** `GET /break/status`, `POST /break/start`, `POST /break/end`.
**Integrations:** IG `connect-system|connect-token|connect|callback|sync`; FB `connect-system|connect-token|sync`; YT `connect|key(POST/DELETE)|sync`; `GET /integrations/connections|status`, `DELETE /integrations/connections/:id`.
**Editors/Activity:** `GET/POST/PATCH/DELETE /editors`, `GET /activity`.

---

## 7. Scoring formulas (both live)

**A. Content Performance Score** (`score.ts`) — how well a *post* performed.
`(ViewRate×20)+(LikeRate×10)+(CommentRate×15)+(ShareRate×30)+(SaveRate×25)`, where each rate = metric ÷ reach × 100. If reach ≤ 0, score = 0.

**B. Task Points** (`task-points.ts`) — how well an *editor* delivered, timeliness-only.
`base_points` = the content format's admin-set points (fallback 1). Completed on/before due → **+100%**; 1 day late → **+50%**; 2 days late → **0%**; 3+ days late → **−100%** (flat). No due date = on-time. Bounded to ±base. Shared by **Media House Leaders**, **Progress Path**, and **My Day's rank** so the three never disagree. *(This resolved the earlier "leaderboard vs Performance-Score" divergence.)*

---

## 8. Non-functional requirements

- **DB connections:** never exceed the 15-client pooler cap; avoid per-item sequential query loops (use set-based `INSERT…SELECT` — the `createWorkspace` pattern). Stop the backend before running a migration.
- **Security:** server-side authz on every mutation; secrets never in code/URLs; tokens encrypted at rest; `.env` gitignored.
- **Performance:** Recharts code-split; single-origin serving (no CORS); optimistic UI for task moves with revert.
- **Collaboration:** two developers on `main` via feature branches; **rebase + conflict-check before every merge**.

---

## 9. Not yet built / roadmap

**Integrations**
- No dedicated Facebook OAuth button (FB via token / IG auto-save); FB views/reach stay blank pending a stable Meta metric.
- **YouTube Tier 2** (OAuth analytics: impressions, avg view duration, traffic sources) — deferred.
- **Auto-import** IG posts (pull posts + links, not just refresh matched) and **scheduled/automatic sync** (needs a paid worker or external cron) — not built.

**Scoring / analytics**
- **YouTube reach/scoring gap:** Performance Score divides by reach, which YouTube has no equivalent for — YouTube needs its own scoring before it feeds the score.
- Deferred dashboard count-mix tiles (Pillar / Content-Type / Format / Post-Type breakdowns).

**Task ops**
- Task **Type + work-timer + Control Panel** admin surface: partially realized via time budgets + accept/pause/resume + Task Settings; a dedicated Control-Panel destination with a Time Log + correction action is still design-stage.
- Calendar carry-forward for overdue tasks; an Overdue filter chip; sync-loop batching (IG/YT per-post loops).

**Open product decision (flagged)**
- **My Day scoping:** currently scoped to the logged-in user for *all* roles. An earlier requirement was **admins see all users' tasks** on My Day; that admin exception is **not** in the current code (removed during a later My Day change). Decide whether to restore admin-sees-all.

**Infra / cleanup**
- Four-file date-formatting duplication; WebP + Supabase Storage for editor images (currently base64); notifications beyond the in-app feed; Meta App Review / Business Verification for assets outside your own roles.

---

## 10. How to run / deploy

- **Local:** backend `node src/index.js` on :4000 (`npm run dev` with `--watch`); frontend Vite on :3000. Set `APP_ENCRYPTION_KEY` locally to exercise token/YouTube-key storage.
- **Deploy:** push to `main` → Render rebuilds automatically. Apply DB migrations to Supabase via `server/scripts/apply-migration.js <file>` run from `server/` (loads `server/.env`); **stop the backend first** (15-client pooler cap).
- **To make connections work in prod:** set `APP_ENCRYPTION_KEY` (`openssl rand -hex 32`) + Meta credentials on Render; add the YouTube API key in-app (Channels → a channel's YouTube Connect).
