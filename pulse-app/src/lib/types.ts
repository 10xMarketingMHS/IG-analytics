// serial = permanent per-scope display number (P#, T#, F#). Numeric — sort by it.
export type Pillar = { id: string; name: string; sort_order: number; serial: number; active: boolean };
export type Avatar = { id: string; name: string; sort_order: number; active: boolean };
export type ContentType = { id: string; pillar_id: string; name: string; serial: number; active: boolean };
// Format is flat (channel-wide) — no pillar_id. post_type is its own attribute.
export type Format = {
  id: string;
  name: string;
  post_type: "reel" | "carousel";
  serial: number;
  active: boolean;
};

export type Taxonomy = {
  pillars: Pillar[];
  avatars: Avatar[];
  contentTypes: ContentType[];
  formats: Format[];
};

export type Role = "admin" | "editor" | "viewer";

export type AppUser = {
  id: string;
  email: string;
  name: string | null;
  active: boolean;
  role: Role;
  isSelf: boolean;
  editor_id: string | null;
};

export type Editor = {
  id: string;
  name: string;
  designation: string;
  image_url: string | null;
  active: boolean;
};

export type Platform = { id: string; key: string; name: string; sort_order: number };

export type Account = {
  id: string;
  channel_id: string;
  channel_name: string;
  platform_id: string;
  platform_key: string;
  platform_name: string;
  sort_order: number;
  handle: string | null;
  // True when this channel×platform has posts — deleting the account is blocked
  // (server 409), so the platform pill is locked from being toggled off.
  has_posts: boolean;
  // YouTube Tier 1 sync state (stored on the account; null for other platforms).
  last_synced_at: string | null;
  last_sync_status: string | null;
  subscriber_count: number | null;
  external_name: string | null;
};

export type PlatformConnection = {
  id: string;
  provider: "instagram" | "facebook" | "youtube";
  external_id: string;
  external_name: string | null;
  token_expires_at: string | null;
  connected_at: string;
  last_synced_at: string | null;
  last_sync_status: string | null;
  follower_count: number | null;
  account_id: string;
  channel_id: string;
  channel_name: string;
  platform_key: string;
  platform_name: string;
};

export type IntegrationStatus = {
  instagram: {
    configured: boolean;
    encryption: boolean;
    systemToken: boolean;
    pasteToken: boolean;
    method: "system" | "oauth" | null;
    ready: boolean;
  };
  facebook?: {
    configured: boolean;
    encryption: boolean;
    systemToken: boolean;
    pasteToken: boolean;
    ready: boolean;
  };
  youtube?: {
    configured: boolean;
    ready: boolean;
    encryption?: boolean;
  };
};

// review is a checkpoint, not just another column — see the status-transition
// guard in server/src/routes/tasks.js: the assignee moves a task through
// todo -> in_progress -> review on their own; only an admin can resolve a
// review (approve into done, or send back to in_progress for rework).
export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high";
// What kind of task it is — distinct from priority (how urgent). "content" is
// reserved for auto-created (post-linked) tasks and isn't user-selectable.
// "emergency" was dropped — priority "high" already covers urgency. "social"
// and "ad" each carry a secondary id (SID/AdID) alongside the task's own TID.
export type TaskType = "content" | "short_task" | "general" | "social" | "ad";

// Type-specific extras for social/ad tasks — optional, only meaningful when
// task_type is "social" or "ad" respectively.
export type TaskMeta = {
  platform?: string;
  caption?: string;
  assetLinks?: string;
  adSpend?: number;
  targetUrl?: string;
};

// Content format is an admin-manageable, org-scoped taxonomy (like Pillars or
// Avatars) rather than a fixed enum — orgs add/rename/retire their own
// categories. See use-content-formats.ts.
export type ContentFormatDef = {
  id: string;
  name: string;
  icon: string;
  sort_order: number;
  active: boolean;
  // Social vs Ads — the category this content type belongs to (null only for
  // retired legacy formats that predate the split).
  category: "social" | "ad" | null;
  // Points Formula base_points for this format — independent of budget_hours
  // (task_time_rule). See taskPoints() in leaderboard.tsx.
  points: number;
};

export type TaskAttachment = { url: string; label?: string };

export type Task = {
  id: string;
  serial: number;
  title: string;
  description: string | null;
  editor_id: string | null;
  channel_id: string | null;
  post_id: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
  content_type: string | null;
  platforms: string[];
  attachments: TaskAttachment[];
  editor_name: string | null;
  editor_image: string | null;
  channel_name: string | null;
  subtask_total: number;
  subtask_done: number;
  recurrence: "none" | "daily" | "weekly";
  task_type: TaskType;
  // Every task has a TID; sid/ad_id are only set for social/ad tasks.
  tid: string | null;
  sid: string | null;
  ad_id: string | null;
  meta: TaskMeta;
  // Bumps every time an admin sends it back from Review for rework — see
  // TaskReviewLogEntry for the note that came with each bump.
  revision: number;
  // Set when sent back for rework — surfaced right at the re-accept moment,
  // then cleared once the assignee accepts. Null otherwise.
  pending_note: string | null;
  content_format_id: string | null;
  content_format_name: string | null;
  content_format_icon: string | null;
  // Points Formula base_points for this task's format — see taskPoints() in
  // leaderboard.tsx. Null only if content_format_id itself is null.
  content_format_points: number | null;
  budget_hours: number | null;
  budget_started_at: string | null;
  // The assignee's break state — offsets the countdown by however long
  // they've been (or are currently) on break, shared across every task
  // they have running. See use-break.ts.
  editor_break_started_at: string | null;
  editor_break_used_seconds: number;
  // False when assigned by someone other than the assignee — the timer
  // doesn't start until they accept (POST /tasks/:id/accept).
  accepted: boolean;
  // Admin "Hold": task is parked (stays In Progress, timer paused) until an
  // admin resumes it.
  on_hold: boolean;
  // Social Media context — only set when post_id is set.
  post_title: string | null;
  post_permalink: string | null;
  platform_key: "instagram" | "facebook" | "youtube" | string | null;
  platform_name: string | null;
};

// GET/POST /break/* — one editor's shared daily break budget (see
// server/src/routes/breaks.js). remainingSeconds already accounts for
// whatever's elapsed of a currently-running break.
export type BreakStatus = {
  onBreak: boolean;
  startedAt?: string;
  usedSeconds: number;
  remainingSeconds: number;
  dailyCapSeconds: number;
  minBreakSeconds: number;
  unlinked?: boolean;
};

// One entry in a task's review history — GET /tasks/:id/reviews, newest first.
export type TaskReviewLogEntry = {
  id: string;
  revision: number;
  action: "approved" | "sent_back";
  note: string | null;
  created_at: string;
  actor_name: string | null;
};

// Admin-configured time-budget rule (Phase 1) — org-wide default (editor_id
// null) or a specific override for one editor, per content format.
export type TaskTimeRule = {
  id: string;
  content_format_id: string;
  content_format_name: string | null;
  content_format_icon: string | null;
  editor_id: string | null;
  editor_name: string | null;
  hours: number;
  updated_at: string;
};

export type ActivityVerb =
  | "created" | "completed" | "assigned" | "commented" | "published"
  | "stage_completed" | "channel_added" | "editor_added";

export type Activity = {
  id: string;
  verb: ActivityVerb;
  entity_type: "task" | "post" | "comment" | "channel" | "editor";
  entity_id: string | null;
  channel_id: string | null;
  summary: string;
  meta: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  channel_name: string | null;
};

export type Subtask = { id: string; title: string; done: boolean; sort_order: number };
export type TaskComment = { id: string; body: string; created_at: string; author_id: string | null; author_name: string | null };

export type PostStatus = "planned" | "published";
export type EditStage = "not_started" | "in_progress" | "in_review" | "pending" | "completed";

export type Post = {
  id: string;
  date: string;
  title: string;
  caption: string | null;
  pillar_id: string;
  content_type_id: string;
  format_id: string;
  avatar_id: string;
  editor_id: string | null;
  platform_id: string | null;
  collab_channel_id: string | null;
  collab_group_id: string | null;
  is_collab_mirror: boolean;
  post_type: "reel" | "carousel";
  status: PostStatus;
  edit_stage: EditStage;
  published_at: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
  metrics_updated_at: string | null;
  permalink: string | null;
  thumbnail_url: string | null;
  notes: string | null;
  source: "manual" | "instagram";
  created_at: string;
  updated_at: string;
};
