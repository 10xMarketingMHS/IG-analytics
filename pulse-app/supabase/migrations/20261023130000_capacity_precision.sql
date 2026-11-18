-- The work calendar (Settings › General) gives a month's capacity in minutes,
-- stored as whole working days × hours a day. Two decimals of hours a day
-- lose a few minutes over a month (176h ÷ 24 days = 7.33h → 175h 55m); four
-- keep it to the minute.
alter table public.editor_capacity alter column hours_per_day type numeric(8,4);
