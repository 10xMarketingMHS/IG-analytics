-- Covered work: a task that reached its person from someone who had already
-- taken it on, through an accepted hand-over, a Move once a hand-over climbed,
-- or a lead reassigning an accepted task. Goal scoring counts it on top of the
-- person's goal (server/src/goal-score.js). Holds who it was taken over from;
-- cleared if it goes back to them.
alter table public.task add column if not exists covered_from_editor_id uuid references public.editor(id) on delete set null;

-- Hand-overs already accepted or moved are covered work.
update public.task t
   set covered_from_editor_id = h.from_editor_id
  from public.task_handover h
 where h.task_id = t.id and h.status in ('accepted', 'moved')
   and h.from_editor_id is not null and t.editor_id is distinct from h.from_editor_id
   and t.covered_from_editor_id is null;
