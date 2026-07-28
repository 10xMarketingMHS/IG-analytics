# Pulse — Product Requirements Document

**Product:** Pulse — Content Analytics & Operations Platform
**Organization:** Media House (DF Foods)
**Document:** PRD v2.0 — Current build
**Status:** Built & running
**Last updated:** 21 Jul 2026

> One workspace to plan content, track editing, measure performance, and rank the
> team — across every brand channel and social platform.

**At a glance:** 4 brand channels · 3 platforms (extensible) · 10 live accounts · 1 shared editing team.

---

## Contents

1. [Overview & Goals](#1-overview--goals)
2. [Users & Roles](#2-users--roles)
3. [Core Concepts & Data Model](#3-core-concepts--data-model)
4. [Channels & Platforms](#4-channels--platforms)
5. [Dashboard](#5-dashboard)
6. [Metrics — Editing Progress](#6-metrics--editing-progress)
7. [Content & Posts](#7-content--posts)
8. [Task Management](#8-task-management)
9. [Leaderboard](#9-leaderboard)
10. [Insights, Reports & Settings](#10-insights-reports--settings)
11. [Scoring Formulas](#11-scoring-formulas)
12. [Non-Functional Requirements](#12-non-functional-requirements)
13. [Architecture & Tech Stack](#13-architecture--tech-stack)
14. [Deployment](#14-deployment)
15. [Roadmap](#15-roadmap)
16. [Glossary](#16-glossary)

---

## 1. Overview & Goals

Media House runs several health-and-food brands (Doctor Farmer, My Health School,
My Health Summit, Fofitos) across Instagram, Facebook and YouTube. Pulse replaces
the scattered spreadsheets and group chats with a single system that covers the
whole content lifecycle — from planning a post, through editing, to measuring how
it performed and who did the work.

### The problem
- Content lives in a manual entry sheet; metrics are copied by hand and quickly go stale.
- No shared view of what each editor is working on or where a post is in the editing pipeline.
- Performance can't be compared across channels or platforms, and there's no objective way to rank editors.
- Adding a new brand or platform means rebuilding the sheet.

### Goals
- **Single source of truth** — every post, metric, editor and task lives in one database, scoped to the Media House organization.
- **Multi-platform by design** — channels × platforms modelled as first-class "accounts", so new brands and networks are configuration, not code.
- **Operational visibility** — see the editing pipeline and each editor's workload at a glance; tasks appear automatically when work is assigned.
- **Objective performance** — transparent, formula-based scoring ranks both content performance and work discipline.

### Non-goals (this version)
- Automatic metric import from platform APIs — planned; metrics are entered manually for now.
- Platform-specific metric sets (watch-time, subscribers) — a shared metric set is used across platforms.
- Public content publishing/scheduling — Pulse tracks content, it does not post it.

---

## 2. Users & Roles

All users belong to the Media House organization. Access is governed by a per-user
role. Editors (the people who edit content) are a separate concept from login users
— see §3.

| Role | Can do | Cannot do |
|---|---|---|
| **Admin** | Everything: manage users, channels, platforms, taxonomy, editors; create & edit content; run tasks. | — |
| **Editor** | Create & edit posts and tasks; advance editing stages; view all analytics. | Manage users, taxonomy, editors, or platform setup. |
| **Viewer** | Read-only access to dashboards, metrics and leaderboards. | Any create / edit / delete action. |

> **Bootstrap admin:** A single environment-configured admin is guaranteed access
> on every startup and can never be locked out of management — the safety net for
> the whole organization.

---

## 3. Core Concepts & Data Model

Pulse is built on a small set of entities. Understanding these makes every feature obvious.

| Entity | What it is | Scope | Key fields |
|---|---|---|---|
| Organization | The "Media House" — the top-level container for everything. | Global (one) | name |
| Channel | A brand account (Doctor Farmer, Fofitos…). Holds content & taxonomy. | Org | name, org |
| Platform | A social network — Instagram, Facebook, YouTube. Extensible. | Global reference | key, name, order |
| Account | One channel on one platform ("Doctor Farmer on YouTube"). The real data source. | Channel × Platform | handle, external_id, token\* |
| Editor (team member) | A person who edits content. Shared across all channels. | Org | name, designation, photo |
| Post | A single piece of content, tied to a channel + platform. | Channel + Platform | see §7 |
| Task | A unit of work assigned to an editor. Manual or auto-created from a post. | Org | title, assignee, due, status, post link |
| Taxonomy | Content Pillars, Content Types, Formats, Audience Avatars. | Channel | see §7 |

\* `token` is reserved for future API auto-sync and is never exposed to the browser.

> **The central idea:** Content is a grid of **Channel × Platform**. Each filled
> cell is an **Account** — the thing that has posts and analytics. This is what
> makes Pulse scale to any number of brands and networks.

---

## 4. Channels & Platforms

A channel can exist on many platforms; not every channel is on every platform. That
presence is stored explicitly as the account grid.

| Channel | Instagram | Facebook | YouTube |
|---|:---:|:---:|:---:|
| Doctor Farmer | ✓ | ✓ | ✓ |
| My Health School | ✓ | ✓ | ✓ |
| My Health Summit | ✓ | ✓ | — |
| Fofitos | ✓ | ✓ | — |

**Functional requirements**

- **FR-4.1 — Add a channel:** an admin can create a new brand channel; it is seeded with the standard taxonomy and joins the org.
- **FR-4.2 — Enable a platform:** an admin can turn a platform on/off for a channel, creating or removing its account. A platform with existing posts cannot be removed.
- **FR-4.3 — Extensible platforms:** adding a new platform (e.g. LinkedIn, TikTok) is a single reference row plus per-channel enablement. No schema change.

> **Pending:** A self-service Channels & Platforms management screen (FR-4.1/4.2
> via UI) is the one remaining piece; today channels are provisioned by the team.

---

## 5. Dashboard

Platform-first analytics. Pick a channel scope at the top, then open a platform to
see its numbers.

- **FR-5.1 — Channel selector:** "All Channels" (aggregated) or a single brand, at the top of the dashboard. Replaces the old top-bar workspace switcher.
- **FR-5.2 — Platform cards:** one card per platform the selected channel is on, each showing a post-count and view summary. Only real accounts appear.
- **FR-5.3 — Drill-in:** clicking a platform card expands its full analytics in place; no navigation.
- **FR-5.4 — Analytics blocks:** KPI tiles (Total Posts, Views, Accounts Reached, Engagement Rate, with period-over-period deltas), Views by Format (reels vs carousels), Top Performers (best reel & carousel by Performance Score), Views by Pillar, Views by Audience Avatar, Content Mix, and Engagement totals.
- **FR-5.5 — Date range:** presets and a custom range filter all analytics; only **Published** posts count.

---

## 6. Metrics — Editing Progress

A live overview of every piece of content moving through the editing pipeline,
across all channels. Distinct from publish status: a post can be scheduled while
its edit is still in review.

**Editing stages:** Not Started → In Progress → In Review → Pending → Completed

- **FR-6.1 — KPI cards:** Total / Completed / In Progress / Pending counts for the current filter.
- **FR-6.2 — Progress donut:** percentage completed, with a legend counting every stage.
- **FR-6.3 — Pipeline table:** each post shows title + content pillar, channel (platform logo only), assigned editor (avatar + name), a stage badge, due date and last-updated time.
- **FR-6.4 — Inline stage change:** change any post's stage directly from the board; KPIs and donut update live.
- **FR-6.5 — Filters:** by editor and by stage.

---

## 7. Content & Posts

A post is one piece of content on one account. Content is created in bulk and edited
one at a time.

### Post fields

| Field | Description | Required |
|---|---|---|
| Channel | The brand account the post belongs to. | Yes |
| Platform | Instagram / Facebook / YouTube (limited to the channel's accounts). | Yes |
| Date | Scheduled / published date. | Yes |
| Title | Post title. | Yes |
| Link | URL of the published post. | No |
| Collab | Another channel this post is a collaboration with. | No |
| Content Pillar | Top-level content theme (e.g. Diabetes, Obesity). | Yes |
| Content Type | Sub-category within the pillar. | Yes |
| Format | Named format template within the pillar. | Yes |
| Post Type | Reel or Carousel. | Yes |
| Audience Avatar | Target audience persona (powers avatar analytics). | Yes |
| Assigned Editor | Team member responsible — auto-creates a task (§8). | No |
| Publish Status | Planned or Published. | Yes |
| Editing Stage | The §6 pipeline stage. | Default: Not Started |
| Metrics | Views, Likes, Comments, Shares, Saves, Accounts Reached. | After publishing |

### Bulk & single entry

- **FR-7.1 — Add Multiple Posts:** a spreadsheet-style modal where each row is a post. Add / duplicate / delete rows, then **Save All**. Per-row cascading: platform follows channel; content type & format follow pillar; each row uses its own channel's taxonomy.
- **FR-7.2 — Edit a post:** clicking a post opens a single-post glass modal with all fields (including Link & Collab), plus a delete action.
- **FR-7.3 — Posts database:** searchable, filterable (All / Planned / Published / Reels / Carousels) table with CSV export.
- **FR-7.4 — Content taxonomy:** Pillars, Audience Avatars, and per-pillar Content Types & Formats are managed in Settings (admin-only add/delete; deletion blocked while in use).

---

## 8. Task Management

A kanban board (To Do → In Progress → Done) for the team's daily work, in its own
"Team" section.

- **FR-8.1 — Manual tasks:** create a standalone task with a title, details, assignee, due date and priority, unlinked to any post.
- **FR-8.2 — Automatic tasks:** assigning an editor to a post auto-creates a linked task for that editor (title, channel, due date carried over). Editing the post keeps the task in sync. Auto-tasks show a "📄 Post" badge.
- **FR-8.3 — Board operations:** assign, set priority, move status, edit and delete. Filter by team member.

> **Two work views, one purpose:** *Task Management* is the team's to-do board;
> *Metrics* (§6) is the content pipeline. Complementary — tasks are people-centric,
> the pipeline is content-centric.

---

## 9. Leaderboard

Two ways to lead, on two tabs — the same team ranked on two independent axes.

**🎬 Social Media Leaders** — ranked on the performance of the Reels & Carousels each
editor produced, aggregated across every channel. Uses weighted-engagement points
(see §11), with a This-Month / All-Time toggle and a featured #1 champion card.

**🏆 Media House Leaders** — ranked on work discipline: **task completion rate**, with
total tasks completed as the tiebreaker so consistency beats a lucky single task.
Its own "Top Performer · Work" champion card.

- **FR-9.1 — Featured champion:** the #1 editor's photo, role and headline stats are shown prominently and update automatically with the ranking.
- **FR-9.2 — Medals:** top three get gold / silver / bronze laurels; the rest are numbered; editors with no qualifying work are listed but unranked.

---

## 10. Insights, Reports & Settings

- **Insights** — rule-based observations computed automatically from published data (top pillar, format that wins on saves, under-served audience), each with a recommendation. No AI writing; fully explainable.
- **Reports** — export and share performance summaries (CSV today; richer exports on the roadmap).
- **Settings** — content taxonomy management, the editing team (add/edit/remove editors with profile photos), and scoring reference.
- **User Management** — admin-only: create users, assign roles, grant or revoke access, deactivate accounts — with last-admin and self-lockout guards.

---

## 11. Scoring Formulas

Every ranking is a transparent formula — no black boxes.

### Performance Score (content)
Each engagement metric is first converted to a rate as a percentage of reach, then
weighted. Reach of zero yields a score of zero.

```
Rate = (metric ÷ reach) × 100

Performance Score =
    (View Rate × 20) + (Like Rate × 10) + (Comment Rate × 15)
  + (Share Rate × 30) + (Save Rate × 25)
```
Weights emphasize the strongest quality signals — shares and saves. Used for the
dashboard's "best performer" cards.

### Social Media Leaders — points
```
Points = Likes + (2 × Comments) + (3 × Shares) + (3 × Saves)
```
Summed across an editor's published Reels & Carousels for the selected period.

### Media House Leaders — Work Score
```
Completion Rate = tasks completed ÷ tasks assigned
Rank by Completion Rate, tiebreak by tasks completed
```
On-time delivery and consistency are captured in the data model and reserved for a
future weighting.

---

## 12. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Performance | Warm, persistent database connection pool with heartbeat (avoids ~2.4s cold-connect to the remote DB); stale-while-revalidate client cache so revisited pages render instantly. Post list responds in ~0.25s. |
| Security | httpOnly JWT session cookie, bcrypt-hashed passwords, per-request role resolution. Secrets (DB, JWT, admin) live in server env only, never in the client or repo. |
| Responsive | Full layouts at 992 / 768 / 576 / 350 px; off-canvas drawer navigation on mobile; horizontally-scrolling tables never break the page. |
| Theming | Purple glassmorphism design system; light & dark themes (dark default) via CSS tokens. |
| Accessibility | Readable contrast in both themes; keyboard-operable modals (Escape / backdrop close); respects reduced-motion. |
| Data integrity | Additive, backed-up migrations; foreign-key guards prevent deleting taxonomy or platforms still in use. |

---

## 13. Architecture & Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Vite · React 19 · TypeScript · React Router | Single-page app; custom purple glass design system in CSS. |
| Backend | Node · Express | REST API under `/api`; JWT auth; org & workspace resolution middleware. |
| Database | Supabase Postgres (Sydney) | Used as pure Postgres via `pg` — no Supabase Auth or RLS. Migrations in SQL. |
| Auth | JWT (httpOnly cookie) · bcryptjs | DB-backed users; env-configured bootstrap admin. |

In production the Express server also serves the built React app, so the whole
product runs as **one service on one origin** — eliminating cross-site cookie and
CORS complexity. In development the React app runs on its own Vite dev server against
the API.

---

## 14. Deployment

- **DEP-1 — Single service on Render** (Singapore region, closest to the Sydney database). One build compiles the React app; the Node server serves it and the API.
- **DEP-2 — Config** via a `render.yaml` blueprint; secrets entered as dashboard environment variables (DB URL, JWT secret, admin credentials).
- **DEP-3 — Source** on GitHub; auto-deploys on push.
- **DEP-4 — Database** is the managed Supabase Postgres instance — shared by local and production.

---

## 15. Roadmap

| Item | Why | Priority |
|---|---|---|
| Channels & Platforms management UI | Add channels / toggle platforms without engineering. | Next |
| Platform API auto-import | Pull metrics automatically (accounts already hold token fields). | High |
| Platform-specific metrics | Watch-time, subscribers (YouTube); reactions (Facebook). | High |
| On-time & consistency in Work Score | Reward reliability, not just completion. | Medium |
| Object storage for images | Full-resolution editor & content imagery. | Medium |
| Metrics timeline view & notifications | Trend of the pipeline; alerts on due/overdue work. | Medium |

---

## 16. Glossary

| Term | Meaning |
|---|---|
| Media House | The organization — the single top-level tenant that owns all channels, team and data. |
| Channel | A brand (Doctor Farmer, Fofitos…). Formerly "workspace". |
| Account | A channel on a specific platform — the unit that holds posts and analytics. |
| Editor | A person who edits content; a shared, org-level team member (not a login role). |
| Publish Status | Whether a post is Planned or Published — drives analytics inclusion. |
| Editing Stage | Where a post sits in the production pipeline (Not Started → Completed). |
| Pillar / Type / Format / Avatar | The four-part content taxonomy that classifies every post. |

---

*Pulse — Product Requirements Document v2.0. Prepared for Media House (DF Foods).
Reflects the current running build across dashboard, metrics, content, tasks, and
leaderboard. Sections marked Pending / roadmap are not yet shipped.*
