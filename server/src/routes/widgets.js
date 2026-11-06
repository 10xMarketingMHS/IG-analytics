import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { hasColumn } from "../schema-flags.js";

// Widgets: each person's own, never anyone else's. Which ones are on their break
// screen, and what they keep. The app works without this table too, on that one
// browser (pulse-app/src/lib/widgets.tsx). 20261115120000_user_widgets
export const widgetsRouter = Router();

const NEEDS_DB = "Saving your widgets needs a database update first — ask whoever runs the database to apply 20261115120000_user_widgets.";
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal(""));
const Schema = z.object({
  picks: z.array(z.enum(["water", "stretch", "chime", "note", "sounds", "game"])).max(6),
  data: z.object({
    water: z.object({
      day: DAY,
      count: z.number().int().min(0).max(99),
      target: z.number().int().min(1).max(30),
      remindMins: z.number().int().min(0).max(480),
    }),
    note: z.string().max(2000),
    pomodoro: z.object({
      focus: z.number().int().min(5).max(120),
      short: z.number().int().min(1).max(60),
      long: z.number().int().min(1).max(60),
      linkFocus: z.boolean(),
      day: DAY,
      done: z.number().int().min(0).max(99),
    }),
  }).strict(),
}).strict();

const ready = () => hasColumn("user_widgets", "picks");

widgetsRouter.get("/widgets/me", async (req, res, next) => {
  try {
    if (!(await ready())) return res.json({ ready: false });
    const { rows } = await pool.query("select picks, data, updated_at from user_widgets where user_id = $1", [req.user.sub]);
    res.json({ ready: true, picks: rows[0]?.picks ?? [], data: rows[0]?.data ?? {}, updatedAt: rows[0]?.updated_at ?? null });
  } catch (err) {
    next(err);
  }
});

widgetsRouter.put("/widgets/me", async (req, res, next) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Those widget settings couldn't be saved." });
  try {
    if (!(await ready())) return res.status(409).json({ error: NEEDS_DB });
    await pool.query(
      `insert into user_widgets (user_id, picks, data) values ($1, $2::jsonb, $3::jsonb)
       on conflict (user_id) do update set picks = excluded.picks, data = excluded.data, updated_at = now()`,
      [req.user.sub, JSON.stringify(parsed.data.picks), JSON.stringify(parsed.data.data)],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
