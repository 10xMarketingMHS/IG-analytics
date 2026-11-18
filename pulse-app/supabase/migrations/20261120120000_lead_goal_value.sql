-- Lead goals (Goals › Lead goals): what one of a key result is worth in ₹ —
-- an L1 Conversion, an L2 Conversion — so the page adds up the revenue each
-- review and the month brought (count × value). Empty for a key result with
-- no money value (Leads, Followers). Safe to run more than once.

alter table public.lead_goal add column if not exists unit_value numeric check (unit_value >= 0);
