import { pool } from "./db.js";
import { editorRanks, rankOf } from "./hierarchy.js";
import { logActivity } from "./activity.js";
import { readSettings } from "./attendance.js";

// Who reviews a task waiting in Review:
//  - a type with its own reviewers (Settings › Access › Review tasks: Rahul
//    for Carousels): them, whoever did it and whoever gave it, their own work
//    of that type included; a sub-type goes with its main type (Video Carousel
//    with Carousel). Still waiting, it's handed on too (below);
//  - one someone else assigned: whoever assigned it, and only them;
//  - one its owner made for themselves: a Manager's or Asst. Manager's needs no
//    review (it closes when they send it); a Team Lead's goes to the Managers
//    and Asst. Managers; anyone else's to the Team Leads, and still waiting,
//    it's handed on too (below). Whoever of them reviews first closes it.
//    Nobody at a level → the next one up.
// Never the owner, except a type's own reviewer above. The Admin role and Super
// Admin don't change any of this.

// Review hand-offs (Settings › Tasks & time; org.settings.review): how many
// hours from handing in a review waits before more people can review it too,
// each with a bell notice. In order:
//   leadHours: the Team Leads (a type's own reviewer's task, for an editor's work)
//   asstHours: the Asst. Managers; none on the team → the Managers, in their
//     place. Off (null): the Asst. Managers come with the Managers.
//   managerHours: the Managers. null: never.
// Each one set comes after the one before. As before this setting: Managers
// and Asst. Managers after a day, no other step.
export const HANDOFF_HOURS = [24, 48, 72, 120, 168];
export const REVIEW_DEFAULTS = { leadHours: null, asstHours: null, managerHours: 24 };
export function normalizeReview(s) {
  const pick = (v, d) => (v === null ? null : HANDOFF_HOURS.includes(v) ? v : d);
  return {
    leadHours: pick(s?.leadHours, REVIEW_DEFAULTS.leadHours),
    asstHours: pick(s?.asstHours, REVIEW_DEFAULTS.asstHours),
    managerHours: pick(s?.managerHours, REVIEW_DEFAULTS.managerHours),
  };
}
// The hand-offs set out of order ("Managers come after the Team Leads: …"), or null.
export function handoffOrderError(r) {
  const set = [["Team Leads", r.leadHours], ["Asst. Managers", r.asstHours], ["Managers", r.managerHours]].filter(([, h]) => h != null);
  for (let i = 1; i < set.length; i++) {
    if (set[i][1] <= set[i - 1][1]) return `${set[i][0]} come after the ${set[i - 1][0]}: pick a longer wait for ${set[i][0]}.`;
  }
  return null;
}
// 24 → "1 day", 48 → "2 days"
export const waitWords = (h) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hours`);
// "Rahul", "Rahul or a Manager", "Rahul, a Team Lead or a Manager"
const orList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : xs[0] ?? "");
// "its reviewer", "its reviewer and the Team Leads", "its reviewer, the Team Leads and …"
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "");

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
//   next: the hand-off still to come ({ who: "a Team Lead", hours }), or null
//   copyAt: when that hand-off happens
//   first / steps (type and Team Lead routes): who has it from the start (ids,
//   and "its reviewer" or "the Team Leads"), and each hand-off in order:
//   { key: "leads" | "asst" | "managers", who, group, hours, to: user ids, done }
export function routeReview(task, ctx, now = Date.now()) {
  const { people, ranks, typeReviewers = new Map(), parentOf = new Map(), rules = REVIEW_DEFAULTS } = ctx;
  const owner = people.find((p) => p.editorId && p.editorId === task.editor_id) ?? null;
  const assigner = task.assigned_by && task.assigned_by !== owner?.userId
    ? people.find((p) => p.userId === task.assigned_by) ?? null
    : null;
  const ownerRank = task.editor_id ? (ranks.get(task.editor_id) ?? owner?.rank ?? 3) : 3;
  // a Manager's or Asst. Manager's own task needs no review
  if (!assigner && ownerRank <= 1) return { kind: "none", reviewers: [], label: null, next: null, copyAt: null };
  const others = people.filter((p) => !(p.editorId && p.editorId === task.editor_id) && p.userId !== owner?.userId);
  const at = (rank) => others.filter((p) => p.rank === rank).map((p) => p.userId);
  const [tops, assts, leads] = [at(0), at(1), at(2)];
  // the Managers and Asst. Managers together (an admin when there are none):
  // a Team Lead's own work, and the Managers' step when Asst. Managers have no step
  let managers = [...tops, ...assts];
  if (!managers.length) managers = others.filter((p) => p.isAdmin).map((p) => p.userId);
  const since = task.review_started_at ? new Date(task.review_started_at).getTime() : now;

  // the hand-offs after the first reviewers, in order (../routes/org.js keeps
  // their waits in order)
  const stepsAfter = (withLeads) => {
    const own = rules.asstHours != null;
    // with a step of their own, the Asst. Managers come first; none on the
    // team → the Managers come in their place
    const top = tops.length ? tops : managers;
    const steps = [
      ...(withLeads ? [{ key: "leads", who: "a Team Lead", group: "the Team Leads", hours: rules.leadHours, to: leads }] : []),
      ...(own ? [assts.length
        ? { key: "asst", who: "an Asst. Manager", group: "the Asst. Managers", hours: rules.asstHours, to: assts }
        : { key: "asst", who: "a Manager", group: "the Managers", hours: rules.asstHours, to: top }] : []),
      { key: "managers", who: "a Manager", group: "the Managers", hours: rules.managerHours, to: own ? top : managers },
    ];
    return steps.map((s) => ({ ...s, done: s.hours != null && s.to.length > 0 && now - since >= s.hours * 3600_000 }));
  };
  // reviewers now, who in words, and the next hand-off that adds someone
  const route = (kind, first, steps) => {
    const done = steps.filter((s) => s.done);
    const reviewers = [...new Set([...first.ids, ...done.flatMap((s) => s.to)])];
    const n = steps.filter((s) => !s.done && s.hours != null && s.to.some((id) => !reviewers.includes(id)))
      .sort((a, b) => a.hours - b.hours)[0];
    return {
      kind, reviewers,
      label: orList([...new Set([...first.names, ...done.map((s) => s.who)])]),
      next: n ? { who: n.who, hours: n.hours } : null,
      copyAt: n ? new Date(since + n.hours * 3600_000).toISOString() : null,
      first, steps,
    };
  };

  // the type's own reviewers (its main type's, for a sub-type): every task of
  // the type, their own included
  const f = task.content_format_id ?? null;
  const ids = new Set([...(f ? typeReviewers.get(f) ?? [] : []), ...(f && parentOf.get(f) ? typeReviewers.get(parentOf.get(f)) ?? [] : [])]);
  const typeFolk = people.filter((p) => ids.has(p.userId));
  if (typeFolk.length) {
    // the Team Leads' step is for work below a Team Lead's
    return route("type", { ids: typeFolk.map((p) => p.userId), names: typeFolk.map((p) => p.name), group: "its reviewer" }, stepsAfter(ownerRank > 2));
  }
  if (assigner) return { kind: "assigner", reviewers: [assigner.userId], label: assigner.name, next: null, copyAt: null };
  if (ownerRank === 2 || !leads.length) return { kind: "managers", reviewers: managers, label: "a Manager", next: null, copyAt: null };
  return route("leads", { ids: leads, names: ["a Team Lead"], group: "the Team Leads" }, stepsAfter(false));
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
// (meta.step "leads", "asst" or "managers"; older notices, without one, were
// the Managers'), and nobody twice. Checked at most once a minute, from the
// activity feed.
const lastCopyCheck = new Map();
export async function syncReviewCopies(orgId) {
  const now = Date.now();
  if (!orgId || now - (lastCopyCheck.get(orgId) ?? 0) < 60_000) return;
  lastCopyCheck.set(orgId, now);
  try {
    const { leadHours, asstHours, managerHours } = normalizeReview((await readSettings(orgId)).raw?.review);
    const hours = [leadHours, asstHours, managerHours].filter((h) => h != null);
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
      // who has it already, and in words, step by step
      const seen = new Set(r.first.ids);
      const groups = [r.first.group];
      for (const s of r.steps) {
        if (!s.done) continue;
        const fresh = s.to.filter((id) => !seen.has(id));
        if (fresh.length && !sent.has(s.key)) {
          await logActivity({
            orgId, actorId: null, verb: "review_copied", entityType: "task", entityId: t.id, channelId: t.channel_id,
            summary: `${from} has waited ${waitWords(s.hours)} for ${andList(groups)}. ${s.who.replace(/^a/, "A")} can review it now`,
            meta: { notifyUserIds: fresh, step: s.key },
          });
        }
        for (const id of fresh) seen.add(id);
        if (fresh.length) groups.push(s.group);
      }
    }
  } catch (err) {
    console.error("review copies:", err.message);
  }
}
