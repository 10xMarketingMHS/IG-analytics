-- Leave: CL (casual leave) and SL (sick leave).
-- CL: each person has their own number a calendar year (any number, set on
-- Team › Attendance by a Super Admin; nothing carries over). Applied for at
-- least 2 days ahead (Settings › Attendance) or each day costs the absence
-- penalty. Past the year's CL the days are unpaid. SL: any time, no limit,
-- recorded. A person applies, a lead approves (or a lead marks it directly);
-- approved days become attendance rows (status leave, or half_day for half).
alter table public.editor add column if not exists cl_per_year numeric(4,1);

create table if not exists public.leave_request (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.org(id) on delete cascade,
  editor_id     uuid not null references public.editor(id) on delete cascade,
  kind          text not null check (kind in ('cl', 'sl')),
  -- the working days it covers
  dates         date[] not null,
  -- a half day (one day only)
  half          boolean not null default false,
  -- CL applied less than the notice days ahead
  short_notice  boolean not null default false,
  status        text not null check (status in ('requested', 'approved', 'declined', 'cancelled')),
  note          text,
  asked_by      uuid references public.app_user(id) on delete set null,
  decided_by    uuid references public.app_user(id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists leave_request_editor_idx on public.leave_request(editor_id, status);
create index if not exists leave_request_org_idx on public.leave_request(org_id, status);

-- An approved leave's days: which leave, CL or SL, and whether it was short
-- notice (that day costs the absence penalty).
alter table public.attendance add column if not exists leave_id uuid references public.leave_request(id) on delete set null;
alter table public.attendance add column if not exists leave_kind text check (leave_kind in ('cl', 'sl'));
alter table public.attendance add column if not exists short_notice boolean not null default false;
