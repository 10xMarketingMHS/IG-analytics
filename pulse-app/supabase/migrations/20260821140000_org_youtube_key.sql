-- User-driven YouTube: the org's YouTube Data API key is entered in-app by an
-- admin and stored ENCRYPTED here (AES-256-GCM, like Meta tokens), instead of a
-- server env var. Once set, any admin connects any number of YouTube channels
-- from inside the app — no backend/env config per channel. Nullable/additive.
alter table public.org
  add column if not exists youtube_api_key_enc text;
