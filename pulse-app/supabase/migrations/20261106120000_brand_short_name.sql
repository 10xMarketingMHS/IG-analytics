-- A brand's short name (Settings › Channels), for tight spots like Home's
-- schedule boxes: DF for Doctor Farmer, MHS for My Health School. Empty: the
-- app makes one from the name's initials.
alter table public.workspace add column if not exists short_name text;
