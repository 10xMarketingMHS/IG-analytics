import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireEditor } from "../resolve-workspace.js";

export const postsRouter = Router();

const CreatePostSchema = z.object({
  date: z.string().min(1),
  title: z.string().min(1),
  caption: z.string().optional(),
  pillarId: z.string().uuid(),
  contentTypeId: z.string().uuid(),
  formatId: z.string().uuid(),
  avatarId: z.string().uuid(),
  editorId: z.string().uuid().optional().or(z.literal("")),
  postType: z.enum(["reel", "carousel"]).optional(),
  status: z.enum(["planned", "published"]).default("planned"),
  views: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  saves: z.number().int().nonnegative().optional(),
  reach: z.number().int().nonnegative().optional(),
  permalink: z.string().url().optional().or(z.literal("")),
  thumbnailUrl: z.string().url().optional().or(z.literal("")),
  notes: z.string().optional(),
});

const UpdatePostSchema = CreatePostSchema.partial();

const POST_COLUMNS = `
  id, date, title, caption, pillar_id, content_type_id, format_id, avatar_id,
  editor_id, post_type, status, published_at, views, likes, comments, shares,
  saves, reach, metrics_updated_at, permalink, thumbnail_url, notes, source,
  created_at, updated_at
`;

postsRouter.get("/posts", async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [req.workspaceId];
    let where = "workspace_id = $1 and deleted_at is null";

    if (status === "planned" || status === "published") {
      params.push(status);
      where += ` and status = $${params.length}`;
    }

    const { rows } = await pool.query(
      `select ${POST_COLUMNS} from post where ${where} order by date desc, created_at desc`,
      params,
    );
    res.json({ posts: rows });
  } catch (err) {
    next(err);
  }
});

postsRouter.get("/posts/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ${POST_COLUMNS} from post
       where id = $1 and workspace_id = $2 and deleted_at is null`,
      [req.params.id, req.workspaceId],
    );
    if (!rows.length) return res.status(404).json({ error: "Post not found" });
    res.json({ post: rows[0] });
  } catch (err) {
    next(err);
  }
});

postsRouter.post("/posts", requireEditor, async (req, res, next) => {
  const parsed = CreatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const p = parsed.data;

  try {
    const { rows } = await pool.query(
      `insert into post (
         workspace_id, date, title, caption, pillar_id, content_type_id,
         format_id, avatar_id, editor_id, post_type, status, views, likes, comments, shares,
         saves, reach, permalink, thumbnail_url, notes, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       returning ${POST_COLUMNS}`,
      [
        req.workspaceId,
        p.date,
        p.title,
        p.caption ?? null,
        p.pillarId,
        p.contentTypeId,
        p.formatId,
        p.avatarId,
        p.editorId || null,
        p.postType ?? null,
        p.status,
        p.views ?? 0,
        p.likes ?? 0,
        p.comments ?? 0,
        p.shares ?? 0,
        p.saves ?? 0,
        p.reach ?? 0,
        p.permalink || null,
        p.thumbnailUrl || null,
        p.notes ?? null,
        req.user.sub,
      ],
    );
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    next(err);
  }
});

postsRouter.patch("/posts/:id", requireEditor, async (req, res, next) => {
  const parsed = UpdatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }
  const p = parsed.data;

  const fieldMap = {
    date: "date",
    title: "title",
    caption: "caption",
    pillarId: "pillar_id",
    contentTypeId: "content_type_id",
    formatId: "format_id",
    avatarId: "avatar_id",
    editorId: "editor_id",
    postType: "post_type",
    status: "status",
    views: "views",
    likes: "likes",
    comments: "comments",
    shares: "shares",
    saves: "saves",
    reach: "reach",
    permalink: "permalink",
    thumbnailUrl: "thumbnail_url",
    notes: "notes",
  };

  const sets = [];
  const params = [req.params.id, req.workspaceId];
  for (const [key, column] of Object.entries(fieldMap)) {
    if (p[key] === undefined) continue;
    params.push(p[key] === "" ? null : p[key]);
    sets.push(`${column} = $${params.length}`);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    const { rows } = await pool.query(
      `update post set ${sets.join(", ")}
       where id = $1 and workspace_id = $2 and deleted_at is null
       returning ${POST_COLUMNS}`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: "Post not found" });
    res.json({ post: rows[0] });
  } catch (err) {
    next(err);
  }
});

postsRouter.delete("/posts/:id", requireEditor, async (req, res, next) => {
  try {
    // Permanent removal (the DELETE is recorded in audit_log by trigger).
    const { rowCount } = await pool.query(
      "delete from post where id = $1 and workspace_id = $2",
      [req.params.id, req.workspaceId],
    );
    if (rowCount === 0) return res.status(404).json({ error: "Post not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
