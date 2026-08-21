# Pulse — Status & PRD

**Product:** Pulse — content-analytics + team-operations platform for **Media House** (the DF Foods / Doctor Farmer marketing team).
**As of:** 2026-08-08 · **Live commit:** `e8288b2` · **Repo:** github.com/10xMarketingMHS/IG-analytics

---

## 1. What Pulse is

A single internal app that runs the Media House content operation end to end:

1. **Track** content across brand channels and platforms (Instagram / Facebook / YouTube).
2. **Analyze** performance — dashboards, trends, per-platform best content, editor leaderboards.
3. **Operate** — an editing pipeline, task board, and activity feed for the team.
4. **Sync** live Instagram metrics automatically instead of manual entry.

One org (**Media House**) → many **Channels** (brands) → each on one or more **Platforms** → a **shared team of editors** → **Posts** (with metrics) and **Tasks**.

---

## 2. Current status — LIVE

Deployed and running on Render, auto-deploying from `main`. Everything below is built, verified, and shipped.

### Foundation
- **Auth:** JWT httpOnly-cookie sessions, bcrypt, env-bootstrapped admin. Roles: **admin / editor / viewer** via membership. Viewers read-only; editors write content; admins manage everything.
- **Single-org model:** Media House. Channels are workspaces under the org; editors are shared org-wide.
- **Design system:** purple glassmorphism, light + dark themes, responsive, full-width layout.

### Channels & Platforms  *(Manage → Channels)*
- Add, **rename (inline), and delete** channels. Delete cascades the channel's posts / platform links / IG connection but **keeps the shared team** and un-links (keeps) tasks; refuses to delete the last channel.
- Toggle which **platforms** (Instagram / Facebook / YouTube) each channel is on.
- **Instagram integration lives inside each channel card** (Integrations page was merged in): Connect (system token, paste-per-account encrypted token, or Facebook OAuth) · **Sync now** · Disconnect · live status + last-sync time.

### Instagram live sync
- Pulls **views, reach, likes, comments, shares, saves** from the Instagram Graph API and writes them onto matching posts.
- Matching is by the **post Link** (permalink) — refresh-only, never creates/deletes posts.
- Three connect paths: **System User token** (`META_SYSTEM_TOKEN`, one-click, never expires), **per-account pasted token** (encrypted at rest with `APP_ENCRYPTION_KEY`, AES-256-GCM), and **OAuth** (`META_APP_ID/SECRET` + `APP_BASE_URL`).
- On-demand (a Sync button). Scheduled/automatic sync is a future add.

### Posts  *(Manage → Posts)*
- Cross-channel **content database** with a Channel column + platform icon + collab badge.
- **Dropdown multi-filters** (combinable — OR within a group, AND across groups): Status · Format · Platform (IG/FB/YT) · Channel · Collabs-only, each with live counts + Clear-all.
- **Date-range picker** (presets + custom) and search.
- **Customizable columns** — a "＋ Columns" menu to show/hide, reorder (↑/↓), and reset any of 18 fields; saved per browser.
- Row click → edit; delete per row.

### Add Post  *(Manage → Add Post)*
- **Channel-grouped cards:** pick a channel → a card with that channel as the header and 1 blank row (＋ Add row for more); "Add Another Post" spins up a new channel card. Bulk-save all.
- Per-row: platform, date, title, Link, **Collab (Instagram-only)**, pillar → content-type / format cascade, post type, avatar, editor, status.
- Assigning an editor to a post **auto-creates a task** for them.
- Single-post edit form for one post.

### Analytics
- **Dashboard:** per-channel, per-platform KPIs, format views, top performers, pillar/avatar breakdowns, content mix, date ranges, period-over-period deltas.
- **Insights:** auto-computed takeaways.
- **Trends:** 12-week / 12-month time-series (Views / Engagement / Avg Score / Posts) with deltas, plus **platform comparison** (IG vs FB vs YT). Recharts, code-split.
- **Top Performers:** best content **per platform separately** — best Reel, best Carousel, category leaders (most views/reach/saves/shares/best engagement), and a ranked top-5 by Performance Score.
- **Reports:** export/share summaries.
- **Editor Leaderboard** — three boards:
  1. **Social Media Leaders** — ranked by content performance (Reels/Carousels points).
  2. **Media House Leaders** — ranked by task completion.
  3. **Progress Path** — a rank-over-time **bump chart** (sports-fixtures style): each editor's avatar rides a path across 7 checkpoints over the last 30 days as their cumulative points change.

### Operations
- **Editing Pipeline:** every post through stages (Not Started → In Progress → In Review → Pending → Completed), with inline stage changes and per-editor/stage filters. Platform-logo view.
- **Task Board:** Board / Calendar toggle; subtasks/checklists with progress; comments thread; **recurring tasks** (daily/weekly, auto-spawn next occurrence); priority, due dates, assignees; posts auto-generate tasks.
- **Activity feed** + topbar **🔔 bell** (unread badge): logs task created/completed/commented, post created/published/stage-complete, channel added, editor added.

### Settings
- Taxonomy (pillars / content types / formats / avatars) per channel, scoring weights, editor management (with profile images), and admin-only user management.

### Scoring
- **Performance Score** = (ViewRate×20)+(LikeRate×10)+(CommentRate×15)+(ShareRate×30)+(SaveRate×25), where each rate = metric ÷ reach × 100.

---

## 3. Architecture

| Layer | Tech |
|-------|------|
| Frontend | Vite + React 19 + TypeScript SPA, React Router, Recharts (code-split), sonner |
| Backend | Node / Express, JWT (httpOnly cookie), bcryptjs, `pg` |
| Database | Supabase Postgres (Sydney) used as plain Postgres — no RLS/Auth. Pooler capped at 15 clients (app pool sized to fit rolling deploys) |
| Hosting | **One** Render web service (Express serves the built React app → single origin, no CORS in prod), Singapore region; auto-deploy from GitHub `main` |
| Secrets | env vars on Render: DB, JWT, admin creds; integration keys (`META_SYSTEM_TOKEN`, `APP_ENCRYPTION_KEY`, `META_APP_ID/SECRET`, `APP_BASE_URL`) |

**Data model:** `org → workspace(channel) → account(channel×platform) / editor(org-shared) → post → task → subtask / task_comment`; plus `platform_connection` (encrypted tokens) and `activity` (event log). Migrations in `pulse-app/supabase/migrations/`.

---

## 4. Not yet built / roadmap

**Integrations**
- **Facebook Page sync** and **YouTube sync** (framework is reusable; Instagram is done).
- **Auto-import** posts from Instagram (pull posts + Links automatically, not just refresh matched ones) — the true "fully link-based, no manual entry" step.
- **Scheduled/automatic sync** (needs a paid Render worker or external cron; today it's on-demand).

**Analytics / UX polish**
- Progress Path modes (content-points vs task-completion), weekly window option.
- URL-synced Posts filters (shareable/bookmarkable), column sorting, CSV export of the filtered set, saved filter presets.
- Rebalance Home so the right column fills top-to-bottom.

**Infra / nice-to-have**
- WebP + Supabase Storage for editor images (currently base64 in DB).
- Notifications beyond the in-app activity feed.
- Meta App Review + Business Verification if syncing accounts outside your own app roles.

---

## 5. How to run

- **Local:** backend `node src/index.js` on :4000; frontend Vite on :3000 (served together in prod).
- **Deploy:** push to `main` → Render rebuilds and redeploys automatically. DB migrations are applied to Supabase via `server/scripts/apply-migration.js` (stop the backend first — 15-client pooler cap).
