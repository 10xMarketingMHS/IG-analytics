-- A work session nobody ended (End Work forgotten, browser closed) is closed
-- automatically once its day is over — at 6 PM office close, IST — and flagged
-- here, so the admin can see the hours weren't confirmed by the person.
alter table public.eod_session add column if not exists auto_closed boolean not null default false;
