export type Pillar = { id: string; name: string; sort_order: number; active: boolean };
export type Avatar = { id: string; name: string; sort_order: number; active: boolean };
export type ContentType = { id: string; pillar_id: string; name: string; active: boolean };
export type Format = {
  id: string;
  pillar_id: string;
  name: string;
  post_type: "reel" | "carousel";
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
};

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export type Task = {
  id: string;
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
  editor_name: string | null;
  editor_image: string | null;
  channel_name: string | null;
};

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
