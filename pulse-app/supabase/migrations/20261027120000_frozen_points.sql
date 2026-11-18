-- Points stay as they were earned. A content type's points (Settings › Tasks
-- & time) can change any time; until now every completed task and every goal
-- was re-scored with today's value, rewriting past months.
--   task.points_at_done  — the type's points the moment the task was approved
--                          as completed (cleared if it's reopened, set again
--                          when it's completed again)
--   editor_goal.points   — the type's points when the goal was first set
-- Existing rows are filled with today's values: older values weren't kept, so
-- this is where history starts.
alter table public.task add column if not exists points_at_done numeric;
alter table public.editor_goal add column if not exists points numeric;

update public.task t
   set points_at_done = cf.points
  from public.task_content_format cf
 where cf.id = t.content_format_id and t.status = 'done' and t.points_at_done is null;

update public.editor_goal g
   set points = cf.points
  from public.task_content_format cf
 where cf.id = g.content_format_id and g.points is null;
