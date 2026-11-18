import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { hasColumn } from "../schema-flags.js";
import { logActivity } from "../activity.js";
import { taskViewer } from "../hierarchy.js";
import { mayPage } from "../page-access.js";

// Knowledge Hub (20261109120000_knowledge_hub): the team's SOPs, brand
// guidelines and training. Everyone reads; the Managers, Asst. Managers and
// Team Leads add, edit and remove — or, once Page access has a position's row
// saved (../page-access.js), whoever its Knowledge Hub Change is ticked for.
// An item is a page written in Echo (plain text with a few marks, shown by the
// app without ever running it as HTML) plus links to files kept elsewhere.
//   GET    /knowledge               ?q=&shelf=&brand=  { shelves, items (no page), canEdit }
//   GET    /knowledge/:id           one item, its page and links
//   POST   /knowledge               { shelfId, brandId?, title, body?, links?, pinned? }
//   PATCH  /knowledge/:id           any of those
//   DELETE /knowledge/:id
//   POST   /knowledge/shelves       { name }
//   PATCH  /knowledge/shelves/:id   { name?, sortOrder? }
//   DELETE /knowledge/shelves/:id   only an empty one
export const knowledgeRouter = Router();

const NEEDS_DB = "The Knowledge Hub needs a database update first — ask whoever runs the database to apply 20261109120000_knowledge_hub.";
const NOT_EDITOR = "Adding and editing the Knowledge Hub is for the Managers and Team Leads.";
const STARTER_SHELVES = ["SOPs", "Brand guidelines", "Training"];
const ready = () => hasColumn("knowledge_item", "pinned");
const leadsToday = async (req) => { const v = await taskViewer(req); return v.seesAll || v.rank <= 2; };
const maySee = (req) => mayPage(req, "knowledge", "see", true);
const mayEdit = (req) => mayPage(req, "knowledge", "change", leadsToday);
const isId = (v) => z.string().uuid().safeParse(v).success;

const Link = z.object({
  label: z.string().trim().max(80, "Keep a link's name under 80 characters.").optional(),
  url: z.string().trim().max(2000).url("A link needs a full address, like https://drive.google.com/…")
    .refine((u) => /^https?:\/\//i.test(u), "Links must start with http:// or https://"),
});
const Fields = {
  shelfId: z.string().uuid("Pick its shelf."),
  brandId: z.string().uuid().nullable(),
  title: z.string().trim().min(1, "Give it a title.").max(120, "Keep the title under 120 characters."),
  body: z.string().max(50_000, "That's too long for one page. Split it in two."),
  links: z.array(Link).max(20, "Twenty links at most."),
  pinned: z.boolean(),
};
const NewSchema = z.object({ ...Fields, brandId: Fields.brandId.optional(), body: Fields.body.optional(), links: Fields.links.optional(), pinned: Fields.pinned.optional() });
const EditSchema = z.object(Fields).partial();
const ShelfSchema = z.object({ name: z.string().trim().min(1, "Name the shelf.").max(40, "Keep the name under 40 characters."), sortOrder: z.number().int().min(0).max(999).optional() });
const firstIssue = (p) => p.error.issues[0]?.message ?? "That couldn't be read.";

const ITEM = `
  select i.id, i.shelf_id as "shelfId", s.name as "shelfName", i.brand_id as "brandId", w.name as "brandName",
         i.title, i.body, i.links, i.pinned, i.created_at as "createdAt", i.updated_at as "updatedAt",
         coalesce(ce.name, cu.name, cu.email) as "createdByName", coalesce(ue.name, uu.name, uu.email) as "updatedByName"
    from knowledge_item i join knowledge_shelf s on s.id = i.shelf_id
    left join workspace w on w.id = i.brand_id
    left join app_user cu on cu.id = i.created_by left join editor ce on ce.id = cu.editor_id
    left join app_user uu on uu.id = coalesce(i.updated_by, i.created_by) left join editor ue on ue.id = uu.editor_id`;
const itemOf = async (orgId, id) => (await pool.query(`${ITEM} where i.id = $1 and i.org_id = $2 and i.deleted_at is null`, [id, orgId])).rows[0] ?? null;

// The shelf and brand an item is put on must be this org's.
async function placeError(orgId, d) {
  if (d.shelfId && !(await pool.query("select 1 from knowledge_shelf where id = $1 and org_id = $2", [d.shelfId, orgId])).rowCount) return "Pick its shelf.";
  if (d.brandId && !(await pool.query("select 1 from workspace where id = $1 and org_id = $2", [d.brandId, orgId])).rowCount) return "That brand wasn't found.";
  return null;
}
const tidyLinks = (links) => links.map((l) => ({ label: l.label || "", url: l.url }));

knowledgeRouter.get("/knowledge", async (req, res, next) => {
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await maySee(req))) return res.status(403).json({ error: "The Knowledge Hub isn't open to your position." });
    // the first time: the three starter shelves
    const { rowCount } = await pool.query("select 1 from knowledge_shelf where org_id = $1 limit 1", [req.orgId]);
    if (!rowCount) {
      await pool.query(
        `insert into knowledge_shelf (org_id, name, sort_order) select $1, n, o from unnest($2::text[]) with ordinality as x(n, o)
         on conflict (org_id, lower(name)) do nothing`,
        [req.orgId, STARTER_SHELVES],
      );
    }
    const shelf = isId(req.query.shelf) ? req.query.shelf : null;
    const brand = isId(req.query.brand) ? req.query.brand : null;
    const qText = String(req.query.q ?? "").trim().slice(0, 100);
    const like = qText ? `%${qText.replace(/[\\%_]/g, "\\$&")}%` : null;
    const [{ rows: shelves }, { rows: items }, canEdit] = await Promise.all([
      pool.query(
        `select s.id, s.name, s.sort_order as "sortOrder", count(i.id) filter (where i.deleted_at is null)::int as items
           from knowledge_shelf s left join knowledge_item i on i.shelf_id = s.id
          where s.org_id = $1 group by s.id order by s.sort_order, lower(s.name)`,
        [req.orgId],
      ),
      pool.query(
        `select i.id, i.shelf_id as "shelfId", i.brand_id as "brandId", w.name as "brandName", i.title, i.pinned,
                -- the page in plain words: links by their names, list bullets and marks dropped
                left(trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(i.body,
                  '\\[([^\\]]*)\\]\\([^)]*\\)', '\\1', 'g'), '(^|\\n)[ \\t]*[-*•][ \\t]+', '\\1', 'g'), '[#*_>]+', '', 'g'), '\\s+', ' ', 'g')), 220) as snippet,
                jsonb_array_length(i.links) as "linkCount", i.updated_at as "updatedAt",
                coalesce(ue.name, uu.name, uu.email) as "updatedByName"
           from knowledge_item i left join workspace w on w.id = i.brand_id
           left join app_user uu on uu.id = coalesce(i.updated_by, i.created_by) left join editor ue on ue.id = uu.editor_id
          where i.org_id = $1 and i.deleted_at is null
            and ($2::uuid is null or i.shelf_id = $2) and ($3::uuid is null or i.brand_id = $3)
            and ($4::text is null or i.title ilike $4 or i.body ilike $4)
          order by i.pinned desc, i.updated_at desc`,
        [req.orgId, shelf, brand, like],
      ),
      mayEdit(req),
    ]);
    res.json({ shelves, items, canEdit });
  } catch (err) { next(err); }
});

knowledgeRouter.get("/knowledge/:id", async (req, res, next) => {
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await maySee(req))) return res.status(403).json({ error: "The Knowledge Hub isn't open to your position." });
    const item = isId(req.params.id) ? await itemOf(req.orgId, req.params.id) : null;
    if (!item) return res.status(404).json({ error: "That page wasn't found." });
    res.json({ item, canEdit: await mayEdit(req) });
  } catch (err) { next(err); }
});

knowledgeRouter.post("/knowledge", async (req, res, next) => {
  const parsed = NewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed) });
  const d = parsed.data;
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEdit(req))) return res.status(403).json({ error: NOT_EDITOR });
    const bad = await placeError(req.orgId, d);
    if (bad) return res.status(400).json({ error: bad });
    const { rows: [r] } = await pool.query(
      `insert into knowledge_item (org_id, shelf_id, brand_id, title, body, links, pinned, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8) returning id`,
      [req.orgId, d.shelfId, d.brandId ?? null, d.title, d.body ?? "", JSON.stringify(tidyLinks(d.links ?? [])), d.pinned ?? false, req.user.sub],
    );
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "knowledge_added", entityType: "knowledge", entityId: r.id,
      summary: `Added “${d.title}” to the Knowledge Hub`,
    });
    res.status(201).json({ item: await itemOf(req.orgId, r.id) });
  } catch (err) { next(err); }
});

knowledgeRouter.patch("/knowledge/:id", async (req, res, next) => {
  const parsed = EditSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed) });
  const d = parsed.data;
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEdit(req))) return res.status(403).json({ error: NOT_EDITOR });
    const prior = isId(req.params.id) ? await itemOf(req.orgId, req.params.id) : null;
    if (!prior) return res.status(404).json({ error: "That page wasn't found." });
    const bad = await placeError(req.orgId, d);
    if (bad) return res.status(400).json({ error: bad });
    const sets = [], params = [req.params.id, req.orgId];
    const push = (col, val, cast = "") => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
    if (d.shelfId !== undefined) push("shelf_id", d.shelfId);
    if (d.brandId !== undefined) push("brand_id", d.brandId);
    if (d.title !== undefined) push("title", d.title);
    if (d.body !== undefined) push("body", d.body);
    if (d.links !== undefined) push("links", JSON.stringify(tidyLinks(d.links)), "::jsonb");
    if (d.pinned !== undefined) push("pinned", d.pinned);
    if (!sets.length) return res.status(400).json({ error: "Nothing to change." });
    params.push(req.user.sub);
    await pool.query(
      `update knowledge_item set ${sets.join(", ")}, updated_by = $${params.length}, updated_at = now()
        where id = $1 and org_id = $2 and deleted_at is null`,
      params,
    );
    const item = await itemOf(req.orgId, req.params.id);
    // a pin moved alone isn't news
    if (Object.keys(d).some((k) => k !== "pinned")) {
      await logActivity({
        orgId: req.orgId, actorId: req.user.sub, verb: "knowledge_updated", entityType: "knowledge", entityId: item.id,
        summary: `Updated “${item.title}” in the Knowledge Hub`,
      });
    }
    res.json({ item });
  } catch (err) { next(err); }
});

knowledgeRouter.delete("/knowledge/:id", async (req, res, next) => {
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEdit(req))) return res.status(403).json({ error: NOT_EDITOR });
    const { rows: [gone] } = isId(req.params.id) ? await pool.query(
      "update knowledge_item set deleted_at = now(), updated_by = $3 where id = $1 and org_id = $2 and deleted_at is null returning title",
      [req.params.id, req.orgId, req.user.sub],
    ) : { rows: [] };
    if (!gone) return res.status(404).json({ error: "That page wasn't found." });
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "knowledge_removed", entityType: "knowledge", entityId: req.params.id,
      summary: `Removed “${gone.title}” from the Knowledge Hub`,
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

knowledgeRouter.post("/knowledge/shelves", async (req, res, next) => {
  const parsed = ShelfSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed) });
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEdit(req))) return res.status(403).json({ error: NOT_EDITOR });
    const { rows } = await pool.query(
      `insert into knowledge_shelf (org_id, name, sort_order)
       values ($1, $2, coalesce($3, (select coalesce(max(sort_order), 0) + 1 from knowledge_shelf where org_id = $1)))
       on conflict (org_id, lower(name)) do nothing returning id, name, sort_order as "sortOrder"`,
      [req.orgId, parsed.data.name, parsed.data.sortOrder ?? null],
    );
    if (!rows.length) return res.status(409).json({ error: `There's already a shelf called ${parsed.data.name}.` });
    res.status(201).json({ shelf: { ...rows[0], items: 0 } });
  } catch (err) { next(err); }
});

knowledgeRouter.patch("/knowledge/shelves/:id", async (req, res, next) => {
  const parsed = ShelfSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed) });
  const d = parsed.data;
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEdit(req))) return res.status(403).json({ error: NOT_EDITOR });
    if (!isId(req.params.id)) return res.status(404).json({ error: "No such shelf." });
    if (d.name !== undefined && (await pool.query(
      "select 1 from knowledge_shelf where org_id = $1 and lower(name) = lower($2) and id <> $3", [req.orgId, d.name, req.params.id],
    )).rowCount) return res.status(409).json({ error: `There's already a shelf called ${d.name}.` });
    const { rows } = await pool.query(
      `update knowledge_shelf set name = coalesce($3, name), sort_order = coalesce($4, sort_order)
        where id = $1 and org_id = $2 returning id, name, sort_order as "sortOrder"`,
      [req.params.id, req.orgId, d.name ?? null, d.sortOrder ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: "No such shelf." });
    res.json({ shelf: rows[0] });
  } catch (err) { next(err); }
});

knowledgeRouter.delete("/knowledge/shelves/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEdit(req))) return res.status(403).json({ error: NOT_EDITOR });
    if (!isId(req.params.id)) return res.status(404).json({ error: "No such shelf." });
    await client.query("BEGIN");
    // held while it's checked, so a page can't land on it meanwhile
    const { rows: [s] } = await client.query("select name from knowledge_shelf where id = $1 and org_id = $2 for update", [req.params.id, req.orgId]);
    if (!s) { await client.query("ROLLBACK"); return res.status(404).json({ error: "No such shelf." }); }
    s.live = (await client.query("select count(*)::int as n from knowledge_item where shelf_id = $1 and deleted_at is null", [req.params.id])).rows[0].n;
    if (s.live) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `${s.name} still has ${s.live === 1 ? "a page" : `${s.live} pages`} on it. Move or remove ${s.live === 1 ? "it" : "them"} first.` });
    }
    // pages removed earlier go with it
    await client.query("delete from knowledge_item where shelf_id = $1 and deleted_at is not null", [req.params.id]);
    await client.query("delete from knowledge_shelf where id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});
