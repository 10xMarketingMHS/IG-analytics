-- Pulse — editor profile image.
-- Stored inline as a small resized data URL (the app has no object storage;
-- images are downscaled client-side before upload), so a text column is fine.

alter table public.editor add column image_url text;
