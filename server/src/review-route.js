import { pool } from "./db.js";
import { editorRanks, rankOf } from "./hierarchy.js";
import { logActivity } from "./activity.js";

// Who reviews a task waiting in Review:
//  - a type with its own reviewers (Settings › Access › Review tasks: Rahul
//    for Carousels): them, whoever did it and whoever gave it — after 24 hours
//    still waiting, a copy to the Managers too; a sub-type goes with its main
//    type (Video Carousel with Carousel). Never the owner: with only the owner
//    there, the rules below;
//  - one someone else assigned: whoever assigned it, and only them;
//  - one its owner made for themselves: a Manager's or Asst. Manager's needs no
//    review (it closes when they send it); a Team Lead's goes to the Managers
//    (Asst. Managers count as Managers); anyone else's to the Team Leads, and
//    after 24 hours still waiting, a copy to the Managers too. Whoever of them
//    reviews first closes it. Nobody at a level → the next one up.
// Never the owner. The Admin role and Super Admin don't change any of this.
export const REVIEW_COPY_HOURS = 24;
const COPY_MS = REVIEW_COPY_HOURS * 3600_000;

// Everyone who can sign in to this org, with their level (hierarchy.js rankOf:
// 0 Manager, 1 Asst. Manager, 2 Team Lead, 3 everyone else).
export async function reviewPeople(orgId) {
  const { rows } = await pool.query(
    `select u.id as "userId", u.editor_id as "editorId", coalesce(e.name, u.name, u.email) as name, e.designation,
            bool_or(m.role = 'admin') as "isAdmin"
       from app_user u
       join membership m on m.user_id = u.id
       join workspace w on w.id = m.workspace_id and w.org_id = $1
       left join editor e on e.id = u.editor_id
      where u.active and (e.id is null or e.active)
      group by u.id, u.editor_id, e.name, u.name, u.email, e.designation`,
    [orgId],
  );
  return rows.map((r) => ({ ...r, rank: rankOf(r.designation, r.isAdmin) }));
}

// What the routing needs, read once per request: the people, their levels,
// and each type's own reviewers (with each type's main type, for sub-types).
export async function reviewContext(orgId) {
  const [people, ranks, grants, types] = await Promise.all([
    reviewPeople(orgId), editorRanks(orgId),
    pool.query("select user_id, scope from user_permission_grant where org_id = $1 and permission_key = 'review_tasks' and revoked_at is null", [orgId]),
    pool.query("select id, (to_jsonb(cf)->>'parent_id')::uuid as parent_id from task_content_format cf where org_id = $1", [orgId]),
  ]);
  const typeReviewers = new Map();
  for (const g of grants.rows) {
    for (const f of Array.isArray(g.scope?.formats) ? g.scope.formats : []) {
      if (!typeReviewers.has(f)) typeReviewers.set(f, new Set());
      typeReviewers.get(f).add(g.user_id);
    }
  }
  const parentOf = new Map(types.rows.map((t) => [t.id, t.parent_id]));
  return { people, ranks, typeReviewers, parentOf };
}

// The route for one task ({ editor_id, assigned_by, content_format_id, review_started_at }):
//   kind: "type" | "assigner" | "managers" | "leads" | "none"
//   reviewers: user ids who may review it now
//   label: who it's waiting for, in words
//   copyAt: when the Managers get a copy (type and Team Lead routes, not yet copied)
export function routeReview(task, ctx, now = Date.now()) {
  const { people, ranks, typeReviewers = new Map(), parentOf = new Map() } = ctx;
  const owner = people.find((p) => p.editorId && p.editorId === task.editor_id) ?? null;
  const assigner = task.assigned_by && task.assigned_by !== owner?.userId
    ? people.find((p) => p.userId === task.assigned_by) ?? null
    : null;
  const ownerRank = task.editor_id ? (ranks.get(task.editor_id) ?? owner?.rank ?? 3) : 3;
  // a Manager's or Asst. Manager's own task needs no review
  if (!assigner && ownerRank <= 1) return { kind: "none", reviewers: [], label: null, copyAt: null };
  const others = people.filter((p) => !(p.editorId && p.editorId === task.editor_id) && p.userId !== owner?.userId);
  let managers = others.filter((p) => p.rank <= 1).map((p) => p.userId);
  if (!managers.length) managers = others.filter((p) => p.isAdmin).map((p) => p.userId);
  const since = task.review_started_at ? new Date(task.review_started_at).getTime() : now;
  const copied = now - since >= COPY_MS;
  // the type's own reviewers (its main type's, for a sub-type)
  const f = task.content_format_id ?? null;
  const ids = new Set([...(f ? typeReviewers.get(f) ?? [] : []), ...(f && parentOf.get(f) ? typeReviewers.get(parentOf.get(f)) ?? [] : [])]);
  const typeFolk = others.filter((p) => ids.has(p.userId));
  if (typeFolk.length) {
    const names = typeFolk.map((p) => p.name);
    const label = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
    const mine = typeFolk.map((p) => p.userId);
    return copied
      ? { kind: "type", reviewers: [...new Set([...mine, ...managers])], label: `${label} or a Manager`, copyAt: null, managers }
      : { kind: "type", reviewers: mine, label, copyAt: new Date(since + COPY_MS).toISOString(), managers };
  }
  if (assigner) return { kind: "assigner", reviewers: [assigner.userId], label: assigner.name, copyAt: null };
  const leads = others.filter((p) => p.rank === 2).map((p) => p.userId);
  if (ownerRank === 2 || !leads.length) return { kind: "managers", reviewers: managers, label: "a Manager", copyAt: null };
  return copied
    ? { kind: "leads", reviewers: [...new Set([...leads, ...managers])], label: "a Team Lead or Manager", copyAt: null, managers }
    : { kind: "leads", reviewers: leads, label: "a Team Lead", copyAt: new Date(since + COPY_MS).toISOString(), managers };
}

// Adds can_review (may this person approve or send it back) and review_by (who
// it's waiting for) to each task in Review.
export async function withReview(req, tasks) {
  const list = Array.isArray(tasks) ? tasks : [tasks];
  if (!list.some((t) => t?.status === "review")) return tasks;
  const ctx = await reviewContext(req.orgId);
  for (const t of list) {
    if (t?.status !== "review") continue;
    const r = routeReview(t, ctx);
    t.can_review = r.reviewers.includes(req.user.sub);
    t.review_by = r.label;
  }
  return tasks;
}

// After 24 hours still waiting for a Team Lead or a type's reviewer, the
// Managers get a copy (a notice in their bell). Checked at most once a minute,
// from the activity feed.
const lastCopyCheck = new Map();
export async function syncReviewCopies(orgId) {
  const now = Date.now();
  if (!orgId || now - (lastCopyCheck.get(orgId) ?? 0) < 60_000) return;
  lastCopyCheck.set(orgId, now);
  try {
    const { rows } = await pool.query(
      `select t.id, t.title, t.editor_id, t.assigned_by, t.content_format_id, t.review_started_at, t.channel_id, e.name as editor_name
         from task t left join editor e on e.id = t.editor_id
        where t.org_id = $1 and t.status = 'review' and t.review_started_at is not null
          and t.review_started_at < now() - make_interval(hours => $2)
          and not exists (select 1 from activity a where a.entity_id = t.id and a.verb = 'review_copied'
                           and a.created_at >= t.review_started_at)`,
      [orgId, REVIEW_COPY_HOURS],
    );
    if (!rows.length) return;
    const ctx = await reviewContext(orgId);
    for (const t of rows) {
      const r = routeReview(t, ctx, now);
      if ((r.kind !== "leads" && r.kind !== "type") || !r.managers?.length) continue;
      await logActivity({
        orgId, actorId: null, verb: "review_copied", entityType: "task", entityId: t.id, channelId: t.channel_id,
        summary: `“${t.title}” from ${t.editor_name ?? "a team member"} has waited ${REVIEW_COPY_HOURS} hours for ${r.kind === "type" ? "its reviewer" : "a Team Lead's review"}`,
        meta: { notifyUserIds: r.managers },
      });
    }
  } catch (err) {
    console.error("review copies:", err.message);
  }
}
