import { pool } from "./db.js";
import { editorRanks, rankOf } from "./hierarchy.js";
import { logActivity } from "./activity.js";

// Who reviews a task waiting in Review:
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

// What the routing needs, read once per request.
export async function reviewContext(orgId) {
  const [people, ranks] = await Promise.all([reviewPeople(orgId), editorRanks(orgId)]);
  return { people, ranks };
}

// The route for one task ({ editor_id, assigned_by, review_started_at }):
//   kind: "assigner" | "managers" | "leads" | "none"
//   reviewers: user ids who may review it now
//   label: who it's waiting for, in words
//   copyAt: when the Managers get a copy (Team Lead route only, not yet copied)
export function routeReview(task, ctx, now = Date.now()) {
  const { people, ranks } = ctx;
  const owner = people.find((p) => p.editorId && p.editorId === task.editor_id) ?? null;
  const assigner = task.assigned_by && task.assigned_by !== owner?.userId
    ? people.find((p) => p.userId === task.assigned_by) ?? null
    : null;
  if (assigner) return { kind: "assigner", reviewers: [assigner.userId], label: assigner.name, copyAt: null };
  const ownerRank = task.editor_id ? (ranks.get(task.editor_id) ?? owner?.rank ?? 3) : 3;
  if (ownerRank <= 1) return { kind: "none", reviewers: [], label: null, copyAt: null };
  const others = people.filter((p) => !(p.editorId && p.editorId === task.editor_id) && p.userId !== owner?.userId);
  let managers = others.filter((p) => p.rank <= 1).map((p) => p.userId);
  if (!managers.length) managers = others.filter((p) => p.isAdmin).map((p) => p.userId);
  const leads = others.filter((p) => p.rank === 2).map((p) => p.userId);
  if (ownerRank === 2 || !leads.length) return { kind: "managers", reviewers: managers, label: "a Manager", copyAt: null };
  const since = task.review_started_at ? new Date(task.review_started_at).getTime() : now;
  const copied = now - since >= COPY_MS;
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

// After 24 hours still waiting for a Team Lead, the Managers get a copy (a
// notice in their bell). Checked at most once a minute, from the activity feed.
const lastCopyCheck = new Map();
export async function syncReviewCopies(orgId) {
  const now = Date.now();
  if (!orgId || now - (lastCopyCheck.get(orgId) ?? 0) < 60_000) return;
  lastCopyCheck.set(orgId, now);
  try {
    const { rows } = await pool.query(
      `select t.id, t.title, t.editor_id, t.assigned_by, t.review_started_at, t.channel_id, e.name as editor_name
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
      if (r.kind !== "leads" || !r.managers?.length) continue;
      await logActivity({
        orgId, actorId: null, verb: "review_copied", entityType: "task", entityId: t.id, channelId: t.channel_id,
        summary: `“${t.title}” from ${t.editor_name ?? "a team member"} has waited ${REVIEW_COPY_HOURS} hours for a Team Lead's review`,
        meta: { notifyUserIds: r.managers },
      });
    }
  } catch (err) {
    console.error("review copies:", err.message);
  }
}
