-- Each day's break, kept on its attendance row (server/src/routes/breaks.js):
-- the minutes taken (in seconds, up to the day's 75 minutes) and how many
-- breaks. Team tracker shows them by day; before this, only today's break
-- was known (on the editor row), and it started over each day.
alter table public.attendance add column if not exists break_seconds integer not null default 0;
alter table public.attendance add column if not exists break_count integer not null default 0;
