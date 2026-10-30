import { pool } from "./db.js";
import { hasColumn } from "./schema-flags.js";
import { isOrgAdmin } from "./permissions.js";

// Discipline: 20% of each person's monthly score, rated on 5 criteria (0–5 stars
// each) by more than one person, each with a share of the 20%:
//   - no one on the roster is an Asst. Manager: Manager 15% · Team Lead 5%
//   - someone is:                                Manager 10% · Asst. Manager 7% · Team Lead 3%
// A rater's role comes from their position (Team › Roster); an admin with no
// position, or anyone given the discipline permission without one of these
// positions, rates as the Manager. The Manager's stars are editor_discipline_points;
// the others' are editor_discipline_review, one row per rater (two Team Leads
// are averaged, criterion by criterion). A criterion nobody in a role has rated
// counts as full marks (5), so no one loses marks before the month-end review.
// The month's attendance points lost (late, absent) come off the total, never
// below 0. One rule for Goals › Discipline and Management Performance (and the
// app's lib/goal-points.ts, which takes the same parts from the server).

export const CRITERIA = ["punctuality", "quality_responsibility", "behaviour", "attendance_availability", "deadline_adherence"];
export const ROLES = ["manager", "asst_manager", "lead"];
const MAX = CRITERIA.length * 5; // 25
export const reviewsReady = () => hasColumn("editor_discipline_review", "deadline_adherence");

const norm = (d) => String(d || "").trim().toLowerCase();
const isAsst = (d) => norm(d) === "asst. manager" || norm(d) === "assistant manager";

// The shares (in %) of the 20%, by whether anyone holds the Asst. Manager position.
export async function disciplineShares(orgId) {
  const { rows } = await pool.query("select designation from editor where org_id = $1 and active", [orgId]);
  return rows.some((r) => isAsst(r.designation))
    ? { manager: 10, asst_manager: 7, lead: 3 }
    : { manager: 15, asst_manager: 0, lead: 5 };
}

// The role someone rates as, by position; null when they don't rate.
export function raterRoleOf(designation, isAdmin, hasDisciplineGrant = false) {
  const p = norm(designation);
  if (p === "manager") return "manager";
  if (isAsst(p)) return "asst_manager";
  if (p === "team lead") return "lead";
  if (isAdmin && !p) return "manager";
  return hasDisciplineGrant || isAdmin ? "manager" : null;
}
// What a rater sees of the others' stars: their own, and those of the roles
// below theirs. The Manager sees everyone's; an Asst. Manager theirs and the
// Team Leads'; a Team Lead only their own. No one sees a role above theirs.
const RANK = { manager: 0, asst_manager: 1, lead: 2 };
export const rolesSeenBy = (role) => ROLES.filter((k) => RANK[k] >= RANK[role]);
export async function raterOf(req, hasDisciplineGrant = false) {
  const { rows } = await pool.query(
    "select u.editor_id, e.designation from app_user u left join editor e on e.id = u.editor_id where u.id = $1",
    [req.user.sub],
  );
  const admin = req.role === "admin" || (await isOrgAdmin(req.orgId, req.user.sub));
  return { editorId: rows[0]?.editor_id ?? null, role: raterRoleOf(rows[0]?.designation, admin, hasDisciplineGrant) };
}

const ratingsOf = (row) => Object.fromEntries(CRITERIA.map((k) => [k, row && row[k] != null ? Number(row[k]) : null]));
// several raters' stars, criterion by criterion (only those who gave one)
function averaged(rows) {
  if (!rows.length) return null;
  return Object.fromEntries(CRITERIA.map((k) => {
    const v = rows.map((r) => r[k]).filter((x) => x != null).map(Number);
    return [k, v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null];
  }));
}

// Each person's stars for a month, by role: { manager, asst_manager, lead } (null: nobody in it rated).
export async function disciplineByEditor(orgId, month, editorId = null) {
  const one = editorId ? " and editor_id = $3" : "";
  const P = editorId ? [orgId, month, editorId] : [orgId, month];
  const [mgr, rev] = await Promise.all([
    pool.query(`select editor_id, ${CRITERIA.join(", ")} from editor_discipline_points where org_id = $1 and period_month = $2${one}`, P),
    (await reviewsReady())
      ? pool.query(`select editor_id, rater_role, rater_user_id, ${CRITERIA.join(", ")}, note, updated_at from editor_discipline_review where org_id = $1 and period_month = $2${one}`, P)
      : { rows: [] },
  ]);
  const out = new Map();
  const get = (id) => { if (!out.has(id)) out.set(id, { manager: null, asst_manager: null, lead: null, raters: [] }); return out.get(id); };
  for (const r of mgr.rows) get(r.editor_id).manager = ratingsOf(r);
  const byRole = new Map();
  for (const r of rev.rows) {
    const k = `${r.editor_id}:${r.rater_role}`;
    if (!byRole.has(k)) byRole.set(k, []);
    byRole.get(k).push(r);
    get(r.editor_id).raters.push({ role: r.rater_role, userId: r.rater_user_id, ratings: ratingsOf(r), note: r.note ?? null, updatedAt: r.updated_at ?? null });
  }
  for (const [k, rows] of byRole) { const [id, role] = k.split(":"); get(id)[role] = averaged(rows); }
  return out;
}

// The Discipline points for a month: each role's stars (unrated criteria as 5)
// over 25, times its share of the goal points; less the attendance points lost.
//   parts: { role: { share, stars, rated } } — stars out of 25, rated: all 5 given
export function disciplinePoints(goalPoints, byRole, shares, penalty = 0) {
  const parts = {};
  let points = 0;
  for (const role of ROLES) {
    const share = shares[role] ?? 0;
    if (!(share > 0)) continue;
    const r = byRole?.[role] ?? null;
    const stars = CRITERIA.reduce((s, k) => s + (r?.[k] ?? 5), 0);
    parts[role] = { share, stars: Math.round(stars * 10) / 10, rated: !!r && CRITERIA.every((k) => r[k] != null), any: !!r && CRITERIA.some((k) => r[k] != null) };
    points += (stars / MAX) * (share / 100) * goalPoints;
  }
  return {
    points: Math.max(0, points - (penalty || 0)),
    ceiling: (Object.values(shares).reduce((s, x) => s + x, 0) / 100) * goalPoints,
    reviewed: Object.values(parts).every((p) => p.rated),
    parts,
  };
}
