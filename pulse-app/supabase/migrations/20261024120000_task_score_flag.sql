-- Task score participation.
--
-- Everyone's tasks count in the Task Points rankings (Home podium and Your
-- score, the Top Performer ticker, Media House Leaders, My Team › Ranking)
-- until a Super Admin switches them out on Team › Roster — say a Team Lead —
-- and back in any time. False is out; null or true counts.
alter table public.editor add column if not exists in_task_score boolean;
