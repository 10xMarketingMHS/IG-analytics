-- Task Management Phase 1: Review status, richer task fields, per-org Task IDs.

-- 1. Add the Review status (To Do -> In Progress -> Review -> Completed).
--    Review is NON-terminal: it is NOT "done", so Leaderboard/Progress-Path
--    completion (which keys off status='done' / completed_at) is unaffected.
alter table public.task drop constraint if exists task_status_check;
alter table public.task
  add constraint task_status_check check (status in ('todo','in_progress','review','done'));

-- 2. New task fields.
alter table public.task
  add column if not exists content_type text,                       -- reel|ad_video|carousel|thumbnail|youtube_video (UI-enforced list)
  add column if not exists platforms   text[]  not null default '{}',   -- subset of instagram|facebook|youtube
  add column if not exists attachments jsonb   not null default '[]'::jsonb, -- [{ "url": "...", "label": "..." }]
  add column if not exists serial      integer;                     -- per-org running number -> "TASK-<serial>"

-- 3. Per-org running Task ID counter. Incremented atomically on task create.
alter table public.org add column if not exists task_seq integer not null default 1000;

-- 4. Backfill existing tasks' serials per org (creation order), starting at 1001.
with numbered as (
  select id, 1000 + row_number() over (partition by org_id order by created_at, id) as s
  from public.task
)
update public.task t set serial = n.s from numbered n
 where n.id = t.id and t.serial is null;

-- 5. Seed each org's counter to its current max serial so new tasks continue.
update public.org o
   set task_seq = greatest(o.task_seq, coalesce(
     (select max(serial) from public.task t where t.org_id = o.id), 1000));
