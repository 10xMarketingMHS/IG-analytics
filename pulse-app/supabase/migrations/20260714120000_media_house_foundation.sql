-- Media House foundation (Phase 1).
-- Additive only — existing tables/columns are untouched so the app keeps working.
--   • org               : the single Media House organization
--   • workspace.org_id  : every channel belongs to the org
--   • editor.org_id     : editors become a shared, org-level team
--   • task              : per-editor daily tasks

-- 1. The organization -------------------------------------------------------
create table if not exists public.org (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Seed exactly one org (idempotent).
insert into public.org (name)
select 'Media House'
where not exists (select 1 from public.org);

-- 2. Channels belong to the org --------------------------------------------
alter table public.workspace add column if not exists org_id uuid references public.org(id);
update public.workspace
   set org_id = (select id from public.org order by created_at limit 1)
 where org_id is null;

-- 3. Editors become an org-level shared team --------------------------------
alter table public.editor add column if not exists org_id uuid references public.org(id);
update public.editor e
   set org_id = w.org_id
  from public.workspace w
 where e.workspace_id = w.id
   and e.org_id is null;

-- 4. Tasks ------------------------------------------------------------------
create table if not exists public.task (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  editor_id uuid references public.editor(id) on delete set null,   -- assignee
  channel_id uuid references public.workspace(id) on delete set null, -- optional
  title text not null,
  description text,
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  due_date date,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists task_org_idx on public.task(org_id);
create index if not exists task_editor_idx on public.task(editor_id);
create index if not exists task_due_idx on public.task(due_date);
