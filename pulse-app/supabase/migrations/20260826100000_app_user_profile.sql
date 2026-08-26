-- Self-service profile: a login account can set its own display photo and
-- accent color (used for its avatar chip wherever they're shown — sidebar,
-- comments, etc.), independent of the "editor" roster record it may or may
-- not be linked to. Both nullable — falls back to an initial-letter avatar
-- with a default color when unset.
alter table public.app_user
  add column if not exists image_url text,
  add column if not exists color text;
