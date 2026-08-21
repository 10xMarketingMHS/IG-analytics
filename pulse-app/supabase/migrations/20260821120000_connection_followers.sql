-- Symmetric platform connections: Instagram, Facebook, and YouTube each get
-- their own platform_connection row. Add a uniform follower/subscriber count so
-- the symmetric UI's "Followers" field has one home across all three providers
-- (IG followers / FB Page follows / YT subscribers). Nullable/additive.
alter table public.platform_connection
  add column if not exists follower_count integer;
