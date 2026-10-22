-- Row level security on for every table in public, with no policies.
--
-- Pulse's server reads and writes the database directly, as the role that owns
-- these tables (the one the migrations run as), and row level security doesn't
-- apply to a table's owner — so the app works exactly as before.
--
-- What it closes: Supabase's public Data API (reached with the project's anon
-- or authenticated key) could otherwise read and write every table — chat
-- messages, leave, password hashes. With row level security on and no policy,
-- those keys see nothing. Pulse's app never uses that API.
--
-- Safe to run more than once. A table added later needs its own
-- "alter table … enable row level security" in its migration.
-- To undo: the same loop with "disable".

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
