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
  // An admin who can also manage other admins (Team › Roster).
  isSuperAdmin?: boolean;
  isSelf: boolean;
  editor_id: string | null;
  // Set while a "Forgot password?" request is waiting for the admin.
  resetRequestedAt?: string | null;
};

export type Editor = {
  id: string;
  name: string;
  designation: string;
  image_url: string | null;
  active: boolean;
  // Company ID shown on the roster, e.g. MHS001.
  employee_code?: string | null;
  // Counts in the Task Points rankings: false when a Super Admin switched them
  // out on the roster; null or true counts (see countsInTaskScore in lib/task-points).
  in_task_score?: boolean | null;
  // The Team Lead this person reports to (Team › Roster); null for none.
  lead_editor_id?: string | null;
  // True when this editor is linked to a user with an admin role. Admins are
  // hidden from "assign an editor" pickers (they don't get assigned editing).
  is_admin?: boolean;
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
  // Auto-sync health (see lib/auto-sync.ts + the sync guard on the server).
  sync_in_progress?: boolean;
  consecutive_failures?: number;
  last_error_type?: "transient" | "permanent" | null;
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
export type TaskType = "content" | "short_task" | "general" | "social" | "ad" | "admin" | "service" | "project";

// Type-specific extras for social/ad tasks — optional, only meaningful when
// task_type is "social" or "ad" respectively.
export type TaskMeta = {
  // Other work: which team asked for a task given to someone (server/src/goal-score.js)
  requestedBy?: string;
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
  // Social / Ads / Service — the category this content type belongs to (null
  // only for retired legacy formats that predate the split).
  category: "social" | "ad" | "service" | "project" | null;
  // Points Formula base_points for this format — independent of budget_hours
  // (task_time_rule). See taskPoints() in leaderboard.tsx.
  points: number;
  // its usual time (the team-wide time rule), for the New task sheet's type chips
  hours?: number | null;
  // Management-metric tag — surfaces goal-vs-achieved for this format under
  // Key / Critical Metrics in Management Performance. null = untagged.
  metric_tier: "key" | "critical" | null;
  // Must a task of this type carry a delivery link before going to review?
  review_link_required: boolean;
  // Does an approved Social task of this type go to Scheduling? Missing until
  // the scheduling database update is applied.
  to_scheduling?: boolean;
  // Project-type-only (category='project'): duration bounds a project's Due
  // Date; metrics_description is free-form documentation only (no scoring use).
  duration_days?: number | null;
  metrics_description?: string | null;
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
  // The login that created the task — null when unknown or auto-created from a
  // post. A task you created for yourself is yours to edit; an assigned one isn't.
  created_by: string | null;
  // Who handed it to its current assignee (app_user id) — with Assign tasks
  // access they may also review it. Null when self-made, picked up or automatic.
  assigned_by?: string | null;
  // The assignee created this task for themselves (marked on cards, in review
  // and in My Team so it can be told apart from assigned work).
  self_created: boolean;
  content_type: string | null;
  platforms: string[];
  attachments: TaskAttachment[];
  // URL to the completed deliverable (distinct from a post's permalink).
  delivery_link: string | null;
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
  svid: string | null;
  // Project ID (per-brand, like sid/ad_id/svid) + start date — only set for
  // task_type='project'. due_date (above) is the project's due date.
  pid: string | null;
  start_date: string | null;
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
  // Project type's configured duration (days) + metrics text, joined from the
  // task's content_format. Only meaningful for task_type='project'.
  content_format_duration: number | null;
  content_format_metrics: string | null;
  // The format's "link required for review" switch; null when the task has no format.
  content_format_link_required: boolean | null;
  // Whether THIS task needs a delivery link to be submitted for review — its
  // own setting if one was chosen when assigning, else the format's default.
  link_required: boolean;
  budget_hours: number | null;
  budget_started_at: string | null;
  // Time banked while the clock waits (on hold, or the day closed).
  budget_used_seconds?: number | null;
  // Time spent waiting for a reviewer, which never counts against the assignee:
  // when it last went into Review (null while it isn't there), and every
  // finished wait added up. See workedUntil() in task-points.ts.
  review_started_at?: string | null;
  review_wait_seconds?: number;
  // In Review: whether you may approve or send it back, and who it's waiting
  // for in words ("Rahul", "a Team Lead") — server/src/review-route.js.
  can_review?: boolean;
  review_by?: string | null;
  // The assignee's break state — offsets the countdown by however long
  // they've been (or are currently) on break, shared across every task
  // they have running. See use-break.ts.
  editor_break_started_at: string | null;
  editor_break_used_seconds: number;
  // False when assigned by someone other than the assignee — the timer
  // doesn't start until they accept (POST /tasks/:id/accept).
  accepted: boolean;
  // "Hold": task is parked (stays In Progress, timer paused) until an admin or
  // the assignee resumes it. held_by/held_by_name record who applied the
  // current hold (informational — shown on the badge).
  on_hold: boolean;
  held_by: string | null;
  held_by_name: string | null;
  // Social Media context — only set when post_id is set.
  post_title: string | null;
  post_permalink: string | null;
  platform_key: "instagram" | "facebook" | "youtube" | string | null;
  platform_name: string | null;
  // Scheduling after approval (lib/schedule.ts): who posts it, since when it's
  // theirs (null: not in scheduling), its post date and how many posts its links made.
  scheduler_id?: string | null;
  scheduler_name?: string | null;
  schedule_from?: string | null;
  post_on?: string | null;
  post_time?: string | null;
  linked_posts?: number;
  // Ad uploads after approval (lib/ad-upload.ts): since when it's waiting for
  // its ads to be recorded (null: not in the list), and how many are.
  upload_from?: string | null;
  ad_count?: number;
  // Ads: the team it's made for (lib/ad-teams.ts), which numbers it instead of a brand
  ad_team_id?: string | null;
  ad_team_name?: string | null;
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
  | "stage_completed" | "channel_added" | "editor_added"
  | "review_requested" | "review_copied" | "sent_back" | "reopened" | "deleted"
  | "held" | "resumed" | "accepted" | "password_reset_requested" | "password_reset" | "sod_submitted"
  // Attendance (Start day, a lead's marks, nudges, corrections, the no-SOD alert)
  | "attendance_check_in" | "attendance_no_sod" | "attendance_nudge" | "attendance_marked" | "attendance_excused"
  | "attendance_undone" | "attendance_correction" | "attendance_correction_answered" | "attendance_late_reason"
  // Hand over (components/handover.tsx)
  | "handover_offered" | "handover_accepted" | "handover_declined" | "handover_cancelled" | "handover_escalated" | "handover_moved"
  // Leave: CL and SL (components/leave-ask.tsx)
  | "leave_asked" | "leave_approved" | "leave_declined" | "leave_cancelled" | "leave_topped_up" | "leave_allowance_set"
  | "leave_counting_started" | "leave_rules_changed" | "attendance_leave_worked"
  // Scheduling approved social work (components/schedule-block.tsx)
  | "schedule_ready" | "schedule_set" | "schedule_linked" | "ad_recorded" | "ad_unrecorded";

export type Activity = {
  id: string;
  verb: ActivityVerb;
  entity_type: "task" | "post" | "comment" | "channel" | "editor" | "user";
  entity_id: string | null;
  channel_id: string | null;
  actor_id: string | null;
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
