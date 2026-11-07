import { pool } from "./db.js";
import { editorRanks, rankOf } from "./hierarchy.js";
import { logActivity } from "./activity.js";
import { readSettings } from "./attendance.js";

// Who reviews a task waiting in Review:
//  - a type with its own reviewers (Settings › Access › Review tasks: Rahul
//    for Carousels): them, whoever did it and whoever gave it, their own work
//    of that type included; a sub-type goes with its main type (Video Carousel
//    with Carousel). Still waiting: the Team Leads too after the hand-off time
//    (for an editor's work; off by default), and the Managers after theirs;
//  - one someone else assigned: whoever assigned it, and only them;
//  - one its owner made for themselves: a Manager's or Asst. Manager's needs no
//    review (it closes when they send it); a Team Lead's goes to the Managers
//    (Asst. Managers count as Managers); anyone else's to the Team Leads, and
//    still waiting after the Managers' hand-off time, the Managers too. Whoever
//    of them reviews first closes it. Nobody at a level → the next one up.
// Never the owner, except a type's own reviewer above. The Admin role and Super
// Admin don't change any of this.

// Review hand-offs (Settings › Tasks & time; org.settings.review): how many
// hours a review waits before it passes on. leadHours: a type's own reviewer's
// task goes to the Team Leads too; managerHours: to the Managers too. null:
// never. As before this setting: Managers after a day, no Team Lead step.
export const HANDOFF_HOURS = [24, 48, 72, 120, 168];
export const REVIEW_DEFAULTS = { leadHours: null, managerHours: 24 };
export function normalizeReview(s) {
  const pick = (v, d) => (v === null ? null : HANDOFF_HOURS.includes(v) ? v : d);
  return { leadHours: pick(s?.leadHours, REVIEW_DEFAULTS.leadHours), managerHours: pick(s?.managerHours, REVIEW_DEFAULTS.managerHours) };
}
// 24 → "1 day", 48 → "2 days"
export const waitWords = (h) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hours`);
// "Rahul", "Rahul or a Manager", "Rahul, a Team Lead or a Manager"
const orList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : xs[0] ?? "");

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
  const [people, ranks, grants, types, settings] = await Promise.all([
    reviewPeople(orgId), editorRanks(orgId),
    pool.query("select user_id, scope from user_permission_grant where org_id = $1 and permission_key = 'review_tasks' and revoked_at is null", [orgId]),
    pool.query("select id, (to_jsonb(cf)->>'parent_id')::uuid as parent_id from task_content_format cf where org_id = $1", [orgId]),
    readSettings(orgId),
  ]);
  const typeReviewers = new Map();
  for (const g of grants.rows) {
    for (const f of Array.isArray(g.scope?.formats) ? g.scope.formats : []) {
      if (!typeReviewers.has(f)) typeReviewers.set(f, new Set());
      typeReviewers.get(f).add(g.user_id);
    }
  }
  const parentOf = new Map(types.rows.map((t) => [t.id, t.parent_id]));
  return { people, ranks, typeReviewers, parentOf, rules: normalizeReview(settings.raw?.review) };
}

// The route for one task ({ editor_id, assigned_by, content_format_id, review_started_at }):
//   kind: "type" | "assigner" | "managers" | "leads" | "none"
//   reviewers: user ids who may review it now
//   label: who it's waiting for, in words
//   next: the hand-off still to come ({ who: "a Team Lead" | "a Manager", hours }), or null
//   copyAt: when that hand-off happens
//   handed: the hand-offs already made ({ leads, managers }), with leads / managers:
//   the user ids each one adds (type and Team Lead routes)
export function routeReview(task, ctx, now = Date.now()) {
  const { people, ranks, typeReviewers = new Map(), parentOf = new Map(), rules = REVIEW_DEFAULTS } = ctx;
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
  const leads = others.filter((p) => p.rank === 2).map((p) => p.userId);
  const since = task.review_started_at ? new Date(task.review_started_at).getTime() : now;
  // a hand-off step: switched on, someone to hand to, and the wait is over?
  const due = (hours, to) => hours != null && to.length > 0 && now - since >= hours * 3600_000;
  // the next hand-off still to come, the sooner first
  const nextOf = (steps) => {
    const n = steps.filter((s) => s.hours != null && s.to.length && !s.done).sort((a, b) => a.hours - b.hours)[0];
    return n ? { next: { who: n.who, hours: n.hours }, copyAt: new Date(since + n.hours * 3600_000).toISOString() } : { next: null, copyAt: null };
  };
  // the type's own reviewers (its main type's, for a sub-type): every task of
  // the type, their own included
  const f = task.content_format_id ?? null;
  const ids = new Set([...(f ? typeReviewers.get(f) ?? [] : []), ...(f && parentOf.get(f) ? typeReviewers.get(parentOf.get(f)) ?? [] : [])]);
  const typeFolk = people.filter((p) => ids.has(p.userId));
  if (typeFolk.length) {
    const mine = typeFolk.map((p) => p.userId);
    // the Team Leads' step is for work below a Team Lead's
    const stepLeads = ownerRank > 2 ? leads : [];
    const handed = { leads: due(rules.leadHours, stepLeads), managers: due(rules.managerHours, managers) };
    return {
      kind: "type",
      reviewers: [...new Set([...mine, ...(handed.leads ? stepLeads : []), ...(handed.managers ? managers : [])])],
      label: orList([...typeFolk.map((p) => p.name), ...(handed.leads ? ["a Team Lead"] : []), ...(handed.managers ? ["a Manager"] : [])]),
      ...nextOf([
        { who: "a Team Lead", hours: rules.leadHours, to: stepLeads, done: handed.leads },
        { who: "a Manager", hours: rules.managerHours, to: managers, done: handed.managers },
      ]),
      handed, leads: stepLeads, managers,
    };
  }
  if (assigner) return { kind: "assigner", reviewers: [assigner.userId], label: assigner.name, next: null, copyAt: null };
  if (ownerRank === 2 || !leads.length) return { kind: "managers", reviewers: managers, label: "a Manager", next: null, copyAt: null };
  const handed = { leads: false, managers: due(rules.managerHours, managers) };
  return {
    kind: "leads",
    reviewers: handed.managers ? [...new Set([...leads, ...managers])] : leads,
    label: handed.managers ? "a Team Lead or Manager" : "a Team Lead",
    ...nextOf([{ who: "a Manager", hours: rules.managerHours, to: managers, done: handed.managers }]),
    handed, leads: [], managers,
  };
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
    // who exactly may review it now, by name (the card's "Waiting for …")
    const names = r.reviewers.map((id) => ctx.people.find((p) => p.userId === id)?.name).filter(Boolean);
    t.review_names = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0] ?? null;
  }
  return tasks;
}

// A review still waiting at a hand-off time (Settings › Tasks & time › Review
// hand-offs): whoever it passes to gets a notice in their bell, once per step
// (meta.step "leads" or "managers"; older notices, without one, were the
// Managers'). Checked at most once a minute, from the activity feed.
const lastCopyCheck = new Map();
export async function syncReviewCopies(orgId) {
  const now = Date.now();
  if (!orgId || now - (lastCopyCheck.get(orgId) ?? 0) < 60_000) return;
  lastCopyCheck.set(orgId, now);
  try {
    const { leadHours, managerHours } = normalizeReview((await readSettings(orgId)).raw?.review);
    const hours = [leadHours, managerHours].filter((h) => h != null);
    if (!hours.length) return;
    const { rows } = await pool.query(
      `select t.id, t.title, t.editor_id, t.assigned_by, t.content_format_id, t.review_started_at, t.channel_id, e.name as editor_name,
              coalesce((select array_agg(coalesce(a.meta->>'step', 'managers')) from activity a
                         where a.entity_id = t.id and a.verb = 'review_copied' and a.created_at >= t.review_started_at), '{}') as sent
         from task t left join editor e on e.id = t.editor_id
        where t.org_id = $1 and t.status = 'review' and t.review_started_at is not null
          and t.review_started_at < now() - make_interval(hours => $2)`,
      [orgId, Math.min(...hours)],
    );
    if (!rows.length) return;
    const ctx = await reviewContext(orgId);
    for (const t of rows) {
      const r = routeReview(t, ctx, now);
      if (r.kind !== "leads" && r.kind !== "type") continue;
      const sent = new Set(t.sent ?? []);
      const from = `“${t.title}” from ${t.editor_name ?? "a team member"}`;
      if (r.handed.leads && !sent.has("leads")) {
        await logActivity({
          orgId, actorId: null, verb: "review_copied", entityType: "task", entityId: t.id, channelId: t.channel_id,
          summary: `${from} has waited ${waitWords(leadHours)} for its reviewer. A Team Lead can review it now`,
          meta: { notifyUserIds: r.leads, step: "leads" },
        });
      }
      if (r.handed.managers && !sent.has("managers")) {
        const waitedFor = r.kind === "leads" ? "a Team Lead's review" : r.handed.leads ? "its reviewer and the Team Leads" : "its reviewer";
        await logActivity({
          orgId, actorId: null, verb: "review_copied", entityType: "task", entityId: t.id, channelId: t.channel_id,
          summary: `${from} has waited ${waitWords(managerHours)} for ${waitedFor}`,
          meta: { notifyUserIds: r.managers, step: "managers" },
        });
      }
    }
  } catch (err) {
    console.error("review copies:", err.message);
  }
}
