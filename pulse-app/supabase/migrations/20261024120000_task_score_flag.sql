-- Task score participation.
--
-- Managers and Team Leads oversee the work, so by default they stay out of the
-- Task Points rankings (Home podium and Your score, the Top Performer ticker,
-- Media House Leaders, My Team › Ranking). A Super Admin can switch anyone in
-- or out on Team › Roster. Null follows the position; true/false is set by hand.
alter table public.editor add column if not exists in_task_score boolean;
