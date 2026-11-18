// A Social job's post details: its Content Pillar, Content Type, Format (which
// sets its Post Type) and Audience Avatar, from its brand's own lists (Settings
// › Content). A Team Lead or a Manager fills them in on the New task form, as
// editors don't know them; they're kept on the task (meta.post) and start the
// post's details when it's scheduled or its post is added (routes/scheduling.js),
// so nobody has to look them up again. Any of them may be left for later.
import { z } from "zod";
import { pool } from "./db.js";

const id = z.string().uuid().nullable().optional();
export const PostDetailsSchema = z.object({ pillarId: id, contentTypeId: id, formatId: id, avatarId: id }).nullable();

const KEYS = ["pillarId", "contentTypeId", "formatId", "avatarId"];
const clean = (d) => Object.fromEntries(KEYS.filter((k) => d?.[k]).map((k) => [k, d[k]]));

// The details as kept on a task, checked against its brand's lists: { post }
// (null when none is picked), or { error }.
export async function checkPostDetails(channelId, details) {
  const d = clean(details);
  if (!Object.keys(d).length) return { post: null };
  if (!channelId) return { error: "Pick the brand first: the post's details come from its lists." };
  if (d.contentTypeId && !d.pillarId) return { error: "Pick the pillar its content type sits under." };
  const { rows: [x] } = await pool.query(
    `select ($1::uuid is null or exists (select 1 from pillar where id = $1 and workspace_id = $5)) as pillar,
            ($2::uuid is null or exists (select 1 from content_type where id = $2 and workspace_id = $5 and pillar_id = $1)) as ctype,
            ($3::uuid is null or exists (select 1 from format where id = $3 and workspace_id = $5)) as format,
            ($4::uuid is null or exists (select 1 from avatar where id = $4 and workspace_id = $5)) as avatar`,
    [d.pillarId ?? null, d.contentTypeId ?? null, d.formatId ?? null, d.avatarId ?? null, channelId],
  );
  if (!x.pillar || !x.ctype || !x.format || !x.avatar) return { error: "Pick the post's details from this brand's lists." };
  return { post: d };
}

// The details a task's post starts from, on its own brand: its own (meta.post),
// or, for a posting copy, the original's. Kept for another brand (the task moved,
// or the copy is for one), each is matched there by its name; one that isn't
// there is left to pick. null when there are none.
export async function taskPostDetails(taskId) {
  const { rows: [t] } = await pool.query(
    `select t.channel_id, coalesce(t.meta->'post', o.meta->'post') as post, case when t.meta ? 'post' then t.channel_id else o.channel_id end as from_brand
       from task t left join task o on o.id::text = t.meta->>'postsFor'
      where t.id = $1`,
    [taskId],
  );
  const d = clean(t?.post);
  if (!t?.channel_id || !Object.keys(d).length) return null;
  const { rows: [m] } = await pool.query(
    `with src as (
       select (select name from pillar where id = $2) as pillar,
              (select name from content_type where id = $3) as ctype,
              (select name from format where id = $4) as format,
              (select name from avatar where id = $5) as avatar
     ), p as (
       select id from pillar where workspace_id = $1 and (id = $2 or lower(name) = lower((select pillar from src)))
        order by (id = $2) desc, active desc limit 1
     )
     select (select id from p) as "pillarId",
            (select c.id from content_type c where c.workspace_id = $1 and c.pillar_id = (select id from p)
               and (c.id = $3 or lower(c.name) = lower((select ctype from src))) order by (c.id = $3) desc, c.active desc limit 1) as "contentTypeId",
            (select f.id from format f where f.workspace_id = $1 and (f.id = $4 or lower(f.name) = lower((select format from src)))
               order by (f.id = $4) desc, f.active desc limit 1) as "formatId",
            (select a.id from avatar a where a.workspace_id = $1 and (a.id = $5 or lower(a.name) = lower((select avatar from src)))
               order by (a.id = $5) desc, a.active desc limit 1) as "avatarId"`,
    [t.channel_id, d.pillarId ?? null, d.contentTypeId ?? null, d.formatId ?? null, d.avatarId ?? null],
  );
  return m && KEYS.some((k) => m[k]) ? m : null;
}
