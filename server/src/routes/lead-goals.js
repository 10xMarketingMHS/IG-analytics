import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission } from "../permissions.js";
import { hasColumn } from "../schema-flags.js";
import { logActivity } from "../activity.js";
import { scoreMonthAll } from "../goal-score.js";

// Goals › Lead goals: a Team Lead's key results for a month — 200 L1
// Conversions, 500 Leads, 50,000 Followers — the team delivers and the lead
// answers for, reviewed at the Tactical meetings: Review 1 (1–15) and Review 2
// (16–month end). A count is typed in at each meeting; Followers is read from
// the connected social accounts. Beside them, how each member's goals stand in
// each review (the same rule as Team goals). Not part of anyone's task score.
// The goal editors (edit_goals) set them for every lead; a Team Lead sees his
// own and types in their numbers.
//   GET  /lead-goals?month=YYYY-MM-01
//   PUT  /lead-goals       { month, editorId, goals: [{ id?, name, kind, target, r1Actual, r2Actual }] }
//   POST /lead-goals/copy  { month, editorId } — last month's key results, without their numbers
// 20261112120000_lead_goal
export const leadGoalsRouter = Router();

const NEEDS_DB = "Lead goals need a database update first — ask whoever runs the database to apply 20261112120000_lead_goal.";
const ready = () => hasColumn("lead_goal", "r2_actual");

function monthStart(v) {
  const m = /^(\d{4})-(\d{2})/.exec(String(v ?? ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}
const prevMonth = (first) => {
  const [y, m] = first.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
};
const lastDayOf = (first) => {
  const [y, m] = first.split("-").map(Number);
  return `${first.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const tenths = (n) => Math.round(n * 10) / 10;
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

// May the caller set goals (Set goals' permission)? Asked of the same check the routes use.
function mayEditGoals(req) {
  return new Promise((resolve, reject) => {
    const res = { status: () => ({ json: () => resolve(false) }) };
    requirePermission("edit_goals", { mode: "change" })(req, res, (err) => (err ? reject(err) : resolve(true)));
  });
}
async function callerEditor(req) {
  const { rows } = await pool.query("select editor_id from app_user where id = $1", [req.user.sub]);
  return rows[0]?.editor_id ?? null;
}
// The Team Leads (Team › Roster position), active
async function teamLeads(orgId) {
  const { rows } = await pool.query(
    `select id, name, image_url as "imageUrl", designation from editor
      where org_id = $1 and active and lower(trim(coalesce(designation, ''))) = 'team lead' order by name`,
    [orgId],
  );
  return rows;
}

// New followers this month, channel by channel and added up: what each
// connected account gained from the month's start to the 15th (Review 1), from
// the 15th to the month's end (Review 2), and over the month — from the daily
// follower counts (follower_snapshot). A channel's start is its last count of
// last month, or, connected during this one, its first count here (so its
// existing followers aren't "new"). A review not over yet runs to now. Net:
// unfollows come off.
async function followerTotals(orgId, month) {
  const end1 = `${month.slice(0, 8)}15`, end2 = lastDayOf(month), prevEnd = lastDayOf(prevMonth(month));
  const today = todayIst();
  const { rows } = await pool.query(
    `select c.id, c.provider, coalesce(c.external_name, a.handle, p.key) as name, w.name as brand, c.follower_count as now,
            (select s.follower_count from follower_snapshot s where s.connection_id = c.id and s.day <= $2::date order by s.day desc limit 1) as before,
            (select s.follower_count from follower_snapshot s where s.connection_id = c.id and s.day > $2::date and s.day <= $4::date order by s.day asc limit 1) as first_in,
            (select s.follower_count from follower_snapshot s where s.connection_id = c.id and s.day > $2::date and s.day <= $3::date order by s.day desc limit 1) as at15,
            (select s.follower_count from follower_snapshot s where s.connection_id = c.id and s.day > $2::date and s.day <= $4::date order by s.day desc limit 1) as at_end
       from platform_connection c
       join account a on a.id = c.account_id
       join platform p on p.id = a.platform_id
       left join workspace w on w.id = a.workspace_id
      where c.org_id = $1 and c.follower_count is not null
      order by w.name nulls last, c.provider`,
    [orgId, prevEnd, end1, end2],
  ).catch(() => ({ rows: [] }));
  const future = today < month;
  const list = rows.map((r) => {
    const now = Number(r.now) || 0;
    if (future) return { id: r.id, provider: r.provider, name: r.name, brand: r.brand, now, r1: 0, r2: 0, month: 0 };
    const start = r.before ?? r.first_in ?? now;
    // the count when Review 1 closed: none on file by the 15th (connected later) — no Review 1 growth
    const mid = today > end1 ? (r.at15 ?? (r.before != null ? r.before : start)) : now;
    const end = today > end2 ? (r.at_end ?? now) : now;
    return { id: r.id, provider: r.provider, name: r.name, brand: r.brand, now, r1: mid - start, r2: today > end1 ? end - mid : 0, month: end - start };
  });
  const sum = (k) => list.reduce((n, x) => n + x[k], 0);
  return { accounts: list.length, now: sum("now"), r1: sum("r1"), r2: sum("r2"), month: sum("month"), list };
}

// How each member's goals stand in each review — Team goals' rule: a review's
// target is half of each type's goal (Review 1 the first half, after leave),
// done is that type's tasks approved in those days, each counted only up to its
// target. Everyone with goals this month who counts in the task score, but the Team Leads.
async function teamReviews(orgId, month) {
  const [scores, people, done] = await Promise.all([
    scoreMonthAll(orgId, month),
    pool.query(
      `select id, name, image_url as "imageUrl", designation from editor
        where org_id = $1 and active and lower(trim(coalesce(designation, ''))) <> 'team lead'
          and coalesce((to_jsonb(editor)->>'in_task_score')::boolean, true)`,
      [orgId],
    ),
    pool.query(
      `select editor_id, content_format_id,
              count(*) filter (where extract(day from completed_at at time zone 'Asia/Kolkata') <= 15)::int as h1,
              count(*) filter (where extract(day from completed_at at time zone 'Asia/Kolkata') > 15)::int as h2
         from task
        where org_id = $1 and status = 'done' and content_format_id is not null and editor_id is not null
          and completed_at >= ($2::date)::timestamp at time zone 'Asia/Kolkata'
          and completed_at < ($2::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'
        group by editor_id, content_format_id`,
      [orgId, month],
    ),
  ]);
  const doneBy = new Map(done.rows.map((r) => [`${r.editor_id}:${r.content_format_id}`, r]));
  const out = [];
  for (const p of people.rows) {
    const types = (scores.get(p.id)?.types ?? []).filter((t) => t.goalJC > 0);
    if (!types.length) continue;
    const half = (h) => {
      let target = 0, got = 0, missed = 0;
      for (const t of types) {
        const first = tenths(t.goal / 2);
        const tg = h === "h1" ? first : tenths(t.goal - first);
        if (!(tg > 0)) continue;
        const d = doneBy.get(`${p.id}:${t.contentFormatId}`)?.[h] ?? 0;
        target += tg; got += Math.min(d, tg);
        if (d < tg) missed++;
      }
      return { target: tenths(target), done: tenths(got), pct: target ? got / target : null, missed };
    };
    out.push({ editorId: p.id, name: p.name, imageUrl: p.imageUrl, designation: p.designation, h1: half("h1"), h2: half("h2") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

leadGoalsRouter.get("/lead-goals", async (req, res, next) => {
  const month = monthStart(req.query.month);
  if (!month) return res.status(400).json({ error: "That month couldn't be read." });
  try {
    const [canEdit, me, leads] = await Promise.all([mayEditGoals(req), callerEditor(req), teamLeads(req.orgId)]);
    const shown = canEdit ? leads : leads.filter((l) => l.id === me);
    if (!canEdit && !shown.length) {
      return res.status(403).json({ error: "Lead goals are for Team Leads and whoever sets the goals." });
    }
    if (!(await ready())) return res.json({ ready: false, month, error: NEEDS_DB });
    const [goals, followers, team] = await Promise.all([
      pool.query(
        `select id, editor_id as "editorId", name, kind, target::float as target, r1_actual::float as "r1Actual", r2_actual::float as "r2Actual", sort_order as "sortOrder"
           from lead_goal where org_id = $1 and period_month = $2 and editor_id = any($3::uuid[]) order by sort_order, created_at`,
        [req.orgId, month, shown.map((l) => l.id)],
      ),
      followerTotals(req.orgId, month),
      teamReviews(req.orgId, month),
    ]);
    res.json({ ready: true, month, prevMonth: prevMonth(month), canEdit, me, leads: shown, goals: goals.rows, followers, team });
  } catch (err) {
    next(err);
  }
});

const GoalRow = z.object({
  id: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["count", "followers"]),
  target: z.number().finite().min(0).max(1e9),
  r1Actual: z.number().finite().min(0).max(1e9).nullable().optional(),
  r2Actual: z.number().finite().min(0).max(1e9).nullable().optional(),
});
const SaveSchema = z.object({ month: z.string(), editorId: z.string().uuid(), goals: z.array(GoalRow).max(30) });

leadGoalsRouter.put("/lead-goals", async (req, res, next) => {
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Each key result needs a name and a target number." });
  const month = monthStart(parsed.data.month);
  if (!month) return res.status(400).json({ error: "That month couldn't be read." });
  const { editorId, goals } = parsed.data;
  const client = await pool.connect();
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    const [canEdit, me, leads] = await Promise.all([mayEditGoals(req), callerEditor(req), teamLeads(req.orgId)]);
    if (!leads.some((l) => l.id === editorId)) return res.status(400).json({ error: "Lead goals are for a Team Lead (Team › Roster position)." });
    if (!canEdit && editorId !== me) return res.status(403).json({ error: "Only whoever sets the goals can change another lead's." });
    await client.query("begin");
    const { rows: have } = await client.query(
      "select id, name, kind, target::float as target from lead_goal where org_id = $1 and period_month = $2 and editor_id = $3 for update",
      [req.orgId, month, editorId],
    );
    const haveBy = new Map(have.map((h) => [h.id, h]));
    if (goals.some((g) => g.id && !haveBy.has(g.id))) { await client.query("rollback"); return res.status(400).json({ error: "That key result wasn't found — reload and try again." }); }
    // a lead types in the numbers; the key results themselves are set by whoever sets the goals
    if (!canEdit) {
      const same = goals.length === have.length && goals.every((g) => {
        const h = g.id && haveBy.get(g.id);
        return h && h.name === g.name && h.kind === g.kind && Number(h.target) === g.target;
      });
      if (!same) { await client.query("rollback"); return res.status(403).json({ error: "You can type in the numbers; whoever sets the goals sets the key results and targets." }); }
    }
    const keep = new Set(goals.filter((g) => g.id).map((g) => g.id));
    for (const h of have) if (!keep.has(h.id)) await client.query("delete from lead_goal where id = $1", [h.id]);
    let i = 0;
    for (const g of goals) {
      const r1 = g.kind === "followers" ? null : g.r1Actual ?? null, r2 = g.kind === "followers" ? null : g.r2Actual ?? null;
      if (g.id) {
        await client.query(
          `update lead_goal set name = $2, kind = $3, target = $4, r1_actual = $5, r2_actual = $6, sort_order = $7, updated_by = $8, updated_at = now() where id = $1`,
          [g.id, g.name, g.kind, g.target, r1, r2, i, req.user.sub],
        );
      } else {
        await client.query(
          `insert into lead_goal (org_id, period_month, editor_id, name, kind, target, r1_actual, r2_actual, sort_order, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [req.orgId, month, editorId, g.name, g.kind, g.target, r1, r2, i, req.user.sub],
        );
      }
      i++;
    }
    await client.query("commit");
    await logActivity({
      orgId: req.orgId, actorId: req.user.sub, verb: "lead_goals_saved", entityType: "lead_goal", entityId: editorId,
      summary: `Saved lead goals for ${leads.find((l) => l.id === editorId)?.name ?? "a Team Lead"} · ${month.slice(0, 7)}`, meta: { month, count: goals.length },
    });
    res.json({ ok: true });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

leadGoalsRouter.post("/lead-goals/copy", async (req, res, next) => {
  const month = monthStart(req.body?.month);
  const editorId = z.string().uuid().safeParse(req.body?.editorId).success ? req.body.editorId : null;
  if (!month || !editorId) return res.status(400).json({ error: "Say which month and which lead." });
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    if (!(await mayEditGoals(req))) return res.status(403).json({ error: "Only whoever sets the goals can copy them." });
    const { rows: has } = await pool.query("select 1 from lead_goal where org_id = $1 and period_month = $2 and editor_id = $3 limit 1", [req.orgId, month, editorId]);
    if (has.length) return res.status(409).json({ error: "This month already has key results — copy only fills an empty month." });
    const { rowCount } = await pool.query(
      `insert into lead_goal (org_id, period_month, editor_id, name, kind, target, sort_order, updated_by)
       select org_id, $2::date, editor_id, name, kind, target, sort_order, $4 from lead_goal
        where org_id = $1 and period_month = $3::date and editor_id = $5`,
      [req.orgId, month, prevMonth(month), req.user.sub, editorId],
    );
    res.json({ ok: true, copied: rowCount });
  } catch (err) {
    next(err);
  }
});
