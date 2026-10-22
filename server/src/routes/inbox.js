import { Router } from "express";
import { pool } from "../db.js";
import { attendancePeople, attendanceReady, callerScope, istNow, permissionsReady } from "../attendance.js";
import { leaveReady, leaveYear, waitingLeave } from "../leave.js";
import { editorRanks, taskViewer } from "../hierarchy.js";
import { isOrgAdmin } from "../permissions.js";
import { withReview } from "../review-route.js";
import { handoverFeed } from "./handover.js";

// The Inbox: everything waiting on you, in one place, and what you sent that's
// still waiting on someone else.
//   waiting — leave, permission and start-time correction requests from people
//     below you (leads and managers); hand-overs offered to you or climbed to
//     you; work waiting for your review; tasks given to you to accept; for
//     admins, forgotten-password requests.
//   sent — your leave and permissions waiting for a lead, hand-overs you
//     offered, your work waiting for review.
// Answering uses the usual routes (attendance, handover, tasks); this only
// gathers. `count` (the waiting ones) is the sidebar badge.
export const inboxRouter = Router();

// the number the board shows (pages/tasks.tsx taskRef)
const REF = "coalesce(t.sid, regexp_replace(t.ad_id, '^AdID', 'AID', 'i'), t.svid, t.pid, t.tid)";
const none = Promise.resolve({ rows: [] });

inboxRouter.get("/inbox", async (req, res, next) => {
  try {
    const today = istNow().ymd;
    const [caller, viewer, ranks, handovers, attOn, permOn, leaveOn, admin] = await Promise.all([
      callerScope(req), taskViewer(req), editorRanks(req.orgId), handoverFeed(req),
      attendanceReady(), permissionsReady(), leaveReady(),
      req.role === "admin" ? true : isOrgAdmin(req.orgId, req.user.sub),
    ]);
    const me = caller.editorId;
    // people whose requests you answer: below you (whoever sees all: everyone but you)
    const people = attOn && caller.scope !== "self"
      ? (await attendancePeople(req.orgId)).filter((p) => p.id !== me && (viewer.seesAll || (ranks.get(p.id) ?? 3) > viewer.rank))
      : [];
    const ids = people.map((p) => p.id);
    const who = new Map(people.map((p) => [p.id, p]));
    const person = (id) => ({ editorId: id, name: who.get(id)?.name ?? "Someone", imageUrl: who.get(id)?.imageUrl ?? null });

    const [leaves, perms, corrections, review, toAccept, myLeave, myPerms, resets] = await Promise.all([
      leaveOn ? waitingLeave(ids) : [],
      permOn && ids.length
        ? pool.query(
          `select id, editor_id as "editorId", date::text as date, part, note, created_at as "at" from attendance_permission
            where editor_id = any($1::uuid[]) and status = 'requested' and date >= $2::date`,
          [ids, today],
        )
        : none,
      ids.length
        ? pool.query(
          `select editor_id as "editorId", date::text as date, correction_at as "correctionAt", correction_note as note,
                  check_in_at as "checkInAt", updated_at as "at" from attendance
            where editor_id = any($1::uuid[]) and correction_status = 'pending' and date >= $2::date - 3 and date <= $2::date`,
          [ids, today],
        )
        : none,
      pool.query(
        `select t.id, t.title, t.editor_id, t.assigned_by, t.review_started_at, ${REF} as ref, e.name as "editorName", e.image_url as "imageUrl"
           from task t left join editor e on e.id = t.editor_id
          where t.org_id = $1 and t.status = 'review'`,
        [req.orgId],
      ),
      me
        ? pool.query(
          `select t.id, t.title, ${REF} as ref, t.due_date::text as due, t.created_at as "at",
                  coalesce(ae.name, au.name, au.email) as "fromName"
             from task t
             left join app_user au on au.id = coalesce(t.assigned_by, t.created_by)
             left join editor ae on ae.id = au.editor_id
            where t.org_id = $1 and t.editor_id = $2 and t.status = 'todo' and not t.accepted`,
          [req.orgId, me],
        )
        : none,
      leaveOn && me
        ? pool.query(
          `select id, editor_id as "editorId", kind, dates::text[] as dates, half, short_notice as "shortNotice", status, note,
                  created_at as "createdAt" from leave_request where editor_id = $1 and status = 'requested'`,
          [me],
        )
        : none,
      permOn && me
        ? pool.query(
          `select id, date::text as date, part, note, created_at as "at" from attendance_permission
            where editor_id = $1 and status = 'requested' and date >= $2::date`,
          [me, today],
        )
        : none,
      admin
        ? pool.query(
          `select u.id as "userId", coalesce(e.name, u.name, u.email) as name, r.at
             from app_user u
             left join editor e on e.id = u.editor_id
             cross join lateral (
               select max(a.created_at) as at from activity a
                where a.org_id = $1 and a.actor_id = u.id and a.verb = 'password_reset_requested'
                  and a.created_at > coalesce((select max(x.created_at) from activity x
                        where x.org_id = $1 and x.entity_id = u.id and x.verb = 'password_reset'), 'epoch')
             ) r
            where u.active and r.at is not null
              and exists (select 1 from membership m join workspace w on w.id = m.workspace_id and w.org_id = $1 where m.user_id = u.id)`,
          [req.orgId],
        )
        : none,
    ]);
    // each asker's CL this year, beside their request
    const [reviewed, balances] = await Promise.all([
      withReview(req, review.rows),
      leaves.length ? leaveYear(leaves.map((l) => l.editorId), Number(today.slice(0, 4))) : new Map(),
    ]);

    const waiting = [
      ...leaves.map((l) => {
        const b = balances.get(l.editorId);
        return { kind: "leave", key: `leave:${l.id}`, at: l.createdAt, ...person(l.editorId), leave: l, balance: b ? { perYear: b.perYear, cl: b.cl, unpaid: b.unpaid } : null };
      }),
      ...perms.rows.map((p) => ({ kind: "permission", key: `permission:${p.id}`, ...p, ...person(p.editorId) })),
      ...corrections.rows.map((c) => ({ kind: "correction", key: `correction:${c.editorId}:${c.date}`, ...c, ...person(c.editorId) })),
      ...handovers.items
        .filter((h) => h.mine === "to" || (h.mine === "reached" && h.canMove && h.level > 0))
        .map((h) => ({ kind: "handover", key: `handover:${h.id}`, at: h.escalatedAt ?? h.createdAt, handover: h })),
      ...reviewed.filter((t) => t.can_review && t.editor_id !== me)
        .map((t) => ({ kind: "review", key: `review:${t.id}`, at: t.review_started_at, taskId: t.id, title: t.title, ref: t.ref, name: t.editorName, imageUrl: t.imageUrl })),
      ...toAccept.rows.map((t) => ({ kind: "accept", key: `accept:${t.id}`, at: t.at, taskId: t.id, title: t.title, ref: t.ref, due: t.due, name: t.fromName })),
      ...resets.rows.map((r) => ({ kind: "reset", key: `reset:${r.userId}`, at: r.at, userId: r.userId, name: r.name })),
    ];
    const sent = [
      ...myLeave.rows.map((l) => ({ kind: "leave", key: `leave:${l.id}`, at: l.createdAt, leave: l })),
      ...myPerms.rows.map((p) => ({ kind: "permission", key: `permission:${p.id}`, ...p })),
      ...handovers.items.filter((h) => h.mine === "from")
        .map((h) => ({ kind: "handover", key: `handover:${h.id}`, at: h.createdAt, handover: h })),
      ...reviewed.filter((t) => me && t.editor_id === me)
        .map((t) => ({ kind: "review", key: `review:${t.id}`, at: t.review_started_at, taskId: t.id, title: t.title, ref: t.ref, reviewBy: t.review_by ?? null })),
    ];
    const newest = (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime();
    res.json({ waiting: waiting.sort(newest), sent: sent.sort(newest), count: waiting.length });
  } catch (err) {
    next(err);
  }
});
