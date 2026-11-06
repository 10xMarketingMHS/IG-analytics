-- Leave: CL (casual leave) and SL (sick leave). Spec: "Leave CL-SL spec.md";
-- rules in server/src/leave-math.js, routes in server/src/routes/leave.js.
--   Each person has a yearly CL and SL allowance (leave_allowance, resets
--   1 Jan, no carry-over). A manager sets everyone's starting numbers once and
--   presses Start counting (org.settings.attendance.leave.countingSince);
--   after that days are only added with a top-up (leave_grant, an audit trail)
--   and only a Super Admin edits the starting numbers.
--   A request holds its paid days while it waits; days past the balance are
--   unpaid. Its notice, short-notice flag and points are fixed when it's sent
--   (short_pts + unpaid_days × unpaid_rate = penalty_pts) and charged only once
--   it's approved. Approved days become attendance rows (leave, or half_day),
--   linked back by attendance.leave_request_id.

create table if not exists public.leave_allowance (
  org_id     uuid not null references public.org(id) on delete cascade,
  editor_id  uuid not null references public.editor(id) on delete cascade,
  year       int not null,
  cl         numeric(4,1) not null default 0,
  sl         numeric(4,1) not null default 0,
  primary key (editor_id, year)
);

create table if not exists public.leave_request (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.org(id) on delete cascade,
  editor_id    uuid not null references public.editor(id) on delete cascade,
  type         text not null check (type in ('CL', 'SL')),
  date_from    date not null,
  date_to      date not null,
  half         text not null default 'full' check (half in ('full', 'first', 'second')),
  days         numeric(4,1) not null,
  paid_days    numeric(4,1) not null,
  unpaid_days  numeric(4,1) not null,
  notice_days  int,
  short_notice boolean not null default false,
  penalty_pts  numeric(4,1) not null default 0,
  -- the two parts of penalty_pts, fixed when it was sent (a re-split at
  -- approval re-prices the unpaid days at the same rate)
  short_pts    numeric(4,1) not null default 0,
  unpaid_rate  numeric(4,1) not null default 0,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  reason       text,
  asked_by     uuid references public.app_user(id) on delete set null,
  decided_by   uuid references public.app_user(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (date_to >= date_from),
  check (half = 'full' or date_from = date_to)
);
create index if not exists leave_request_editor_from_idx on public.leave_request (editor_id, date_from);
create index if not exists leave_request_org_status_idx on public.leave_request (org_id, status);

-- Top-ups: days added after counting started, each with its reason.
create table if not exists public.leave_grant (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.org(id) on delete cascade,
  editor_id   uuid not null references public.editor(id) on delete cascade,
  year        int not null,
  type        text not null check (type in ('CL', 'SL')),
  days        numeric(4,1) not null check (days > 0),
  note        text not null,
  granted_by  uuid not null references public.app_user(id),
  created_at  timestamptz not null default now()
);
create index if not exists leave_grant_editor_year_idx on public.leave_grant (editor_id, year);

-- An approved leave's days in attendance. Kept when the person checks in on
-- one anyway (the day turns back into a working day), so Undo Start day can
-- put the leave back.
alter table public.attendance add column if not exists leave_request_id uuid references public.leave_request(id) on delete set null;
