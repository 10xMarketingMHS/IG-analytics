-- Whether a task type is tracked in goals (Settings › Tasks & time › Goal).
-- Off: it isn't offered in Set goals and never counts as goal work; a task of
-- it someone is given is Other work, taking its time off their goal
-- (server/src/goal-score.js rule 6). The New task sheet lists it under
-- "Off-goal". On, the default, for every type there is today. Safe to run more than once.

alter table public.task_content_format add column if not exists counts_in_goal boolean not null default true;
