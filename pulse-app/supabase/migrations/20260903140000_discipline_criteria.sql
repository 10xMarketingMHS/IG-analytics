-- Discipline Points become 5 rated criteria (0–5 each) instead of a single
-- number. Discipline Points = (Σ ratings ÷ 25) × (20% × Total Goal Points),
-- computed live; each unrated criterion counts as 5 (full marks) until set.
--
-- Reshape the table the previous migration created: drop the single `points`
-- column, add the five rating columns (flat, since the 5 criteria are fixed).
alter table public.editor_discipline_points
  drop column if exists points,
  add column if not exists punctuality smallint check (punctuality between 0 and 5),
  add column if not exists quality_responsibility smallint check (quality_responsibility between 0 and 5),
  add column if not exists behaviour smallint check (behaviour between 0 and 5),
  add column if not exists attendance_availability smallint check (attendance_availability between 0 and 5),
  add column if not exists deadline_adherence smallint check (deadline_adherence between 0 and 5);
