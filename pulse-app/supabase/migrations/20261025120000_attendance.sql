-- Attendance: Start of day check-in, late / no-SOD / absent / leave, and the
-- role-based Home.
--
-- Team leads: each team member can be assigned to one Team Lead (Team ›
-- Roster); a lead sees and acts on attendance only for their own people.
alter table public.editor add column if not exists lead_editor_id uuid references public.editor(id) on delete set null;

-- One row per team member per day (IST). Created when they check in, when the
-- no-SOD alert time passes without a check-in, when the auto-absent time
-- passes, or when a lead marks them. "Not in yet" (before the alert time) has
-- no row. Penalties: late (unless excused) and absent (unplanned) feed the
-- month's discipline score; leave and half-day never count.
create table if not exists public.attendance (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.org(id) on delete cascade,
  editor_id         uuid not null references public.editor(id) on delete cascade,
  date              date not null,
  check_in_at       timestamptz,
  check_out_at      timestamptz,
  plan_note         text,
  eod_note          text,
  status            text not null default 'no_sod'
                    check (status in ('on_time', 'late', 'no_sod', 'absent', 'leave', 'half_day')),
  late_minutes      integer not null default 0,
  excused           boolean not null default false,
  marked_by         uuid references public.app_user(id) on delete set null,
  auto_marked       boolean not null default false,
  reason            text,
  alert_sent_at     timestamptz,
  nudged_at         timestamptz,
  -- "Started earlier? Request a correction": the start time asked for, and
  -- the lead's answer.
  correction_at     timestamptz,
  correction_note   text,
  correction_status text check (correction_status in ('pending', 'approved', 'declined')),
  updated_at        timestamptz not null default now(),
  unique (editor_id, date)
);
create index if not exists attendance_org_date_idx on public.attendance(org_id, date);

-- Each person's own Home layout, per Home role (manager / lead / editor):
-- the widgets in order with their size, and whether the banner shows.
-- The org's published defaults live in org.settings.homeDefaults.
create table if not exists public.home_layout (
  user_id    uuid not null references public.app_user(id) on delete cascade,
  role       text not null check (role in ('manager', 'lead', 'editor')),
  layout     jsonb not null,
  banner     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, role)
);
