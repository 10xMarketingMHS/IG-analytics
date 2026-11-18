import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";

// Each post's numbers, day by day (20261108120000_post_metric_day): the totals a
// sync — or numbers typed into a post — left that day, India time. One row per
// post per day, written only when they changed since its last row, so a post
// nobody watches any more costs nothing. The last 90 days are kept day by day;
// older days are thinned to one row a week (each week's last). Analytics reads
// it to count views as they came in: a post's total at the end of a range minus
// its total just before it.

export const historyReady = () => hasColumn("post_metric_day", "post_id");
const TODAY = "(now() at time zone 'Asia/Kolkata')::date";
export const KEEP_DAILY_DAYS = 90;

// Today's totals for these posts (published ones), where they've changed —
// or today's row brought up to date when there already is one.
export async function recordMetricDays(postIds, db = pool) {
  if (!postIds?.length || !(await historyReady())) return;
  await db.query(
    `with cur as (
       select id, views, reach, likes, comments, shares, saves from post
        where id = any($1::uuid[]) and deleted_at is null and status = 'published'
     ), prev as (
       select distinct on (d.post_id) d.post_id, d.views, d.reach, d.likes, d.comments, d.shares, d.saves
         from post_metric_day d join cur on cur.id = d.post_id
        where d.day < ${TODAY}
        order by d.post_id, d.day desc
     )
     insert into post_metric_day (post_id, day, views, reach, likes, comments, shares, saves)
     select cur.id, ${TODAY}, cur.views, cur.reach, cur.likes, cur.comments, cur.shares, cur.saves
       from cur left join prev on prev.post_id = cur.id
      where prev.post_id is null
         or (prev.views, prev.reach, prev.likes, prev.comments, prev.shares, prev.saves)
            is distinct from (cur.views, cur.reach, cur.likes, cur.comments, cur.shares, cur.saves)
         or exists (select 1 from post_metric_day t where t.post_id = cur.id and t.day = ${TODAY})
     on conflict (post_id, day) do update set
       views = excluded.views, reach = excluded.reach, likes = excluded.likes,
       comments = excluded.comments, shares = excluded.shares, saves = excluded.saves`,
    [postIds],
  );
}

// Days older than 90 thinned to one row a week: each week's last stays.
export async function thinMetricDays(db = pool) {
  if (!(await historyReady())) return 0;
  const { rowCount } = await db.query(
    `delete from post_metric_day d
      where d.day < ${TODAY} - ${KEEP_DAILY_DAYS}
        and exists (select 1 from post_metric_day n
                     where n.post_id = d.post_id and n.day > d.day
                       and date_trunc('week', n.day) = date_trunc('week', d.day))`,
  );
  return rowCount;
}

// The thinning, once a day from the server: a minute after it starts, then
// checked every six hours (it sleeps when idle, so a timer can't promise a time).
let lastThin = 0;
export function startThinning() {
  const run = () => {
    if (Date.now() - lastThin < 20 * 60 * 60 * 1000) return;
    lastThin = Date.now();
    thinMetricDays().catch((err) => console.error("thinMetricDays failed:", err.message));
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}
