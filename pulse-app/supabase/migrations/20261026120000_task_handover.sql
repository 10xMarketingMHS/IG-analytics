-- Hand over: someone passes their own task to a teammate, who accepts or
-- declines. Until they answer, the task stays with its owner (its timer
-- paused). Accepting makes it theirs, so its points go to them when it's done.
-- Unanswered, it climbs the team: at the close of the work day it was offered
-- the Team Leads are warned; at the next close it reaches the Asst. Managers;
-- at the one after, the Managers. Whoever it has reached can move it on.
create table if not exists public.task_handover (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.org(id) on delete cascade,
  task_id         uuid not null references public.task(id) on delete cascade,
  from_editor_id  uuid references public.editor(id) on delete set null,
  to_editor_id    uuid references public.editor(id) on delete set null,
  offered_by      uuid references public.app_user(id) on delete set null,
  note            text,
  status          text not null default 'pending'
                  check (status in ('pending', 'accepted', 'declined', 'cancelled', 'moved')),
  -- 0 = not yet climbed · 1 = Team Leads warned · 2 = Asst. Managers · 3 = Managers
  level           smallint not null default 0,
  -- everyone it has reached so far (they may move it on)
  reached         uuid[] not null default '{}',
  escalated_at    timestamptz,
  -- the owner's running timer was paused for it (given back on decline / cancel)
  paused          boolean not null default false,
  answer_note     text,
  answered_by     uuid references public.app_user(id) on delete set null,
  answered_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- One waiting hand-over per task.
create unique index if not exists task_handover_one_pending on public.task_handover (task_id) where status = 'pending';
create index if not exists task_handover_org_pending on public.task_handover (org_id) where status = 'pending';
