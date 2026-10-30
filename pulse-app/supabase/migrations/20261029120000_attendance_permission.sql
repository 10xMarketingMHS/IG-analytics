-- Permission: a few a month per person (Settings › Attendance, 2 by default),
-- morning (come in late, covered until the half-day time) or evening (leave
-- early, only recorded). Asked ahead and approved by a lead, or used on the
-- day: a late morning uses one automatically while any are left, and so does
-- ending the day early. A morning permission takes away the late mark
-- (attendance.excused, reason 'permission').
create table if not exists public.attendance_permission (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.org(id) on delete cascade,
  editor_id   uuid not null references public.editor(id) on delete cascade,
  date        date not null,
  part        text not null check (part in ('morning', 'evening')),
  status      text not null check (status in ('requested', 'approved', 'declined', 'used')),
  -- used on the day without asking first
  emergency   boolean not null default false,
  note        text,
  asked_by    uuid references public.app_user(id) on delete set null,
  decided_by  uuid references public.app_user(id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (editor_id, date, part)
);
create index if not exists attendance_permission_org_date_idx on public.attendance_permission(org_id, date);

-- Not in by the half-day time (11:30 AM by default): a half-day absence, half
-- the absence penalty; still not in by the absent time (1:30 PM): absent.
alter table public.attendance drop constraint if exists attendance_status_check;
alter table public.attendance add constraint attendance_status_check
  check (status in ('on_time', 'late', 'no_sod', 'absent', 'leave', 'half_day', 'half_absent'));
