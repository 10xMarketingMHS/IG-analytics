-- Content formats can be flagged as a Key Metric or a Critical Metric, so
-- Management Performance can report each editor's goal vs achieved specifically
-- against the metrics management cares about. Optional — an untagged format is
-- neither. Set in Task Settings → Content Format; tasks inherit it via their
-- content_format_id.
alter table public.task_content_format
  add column if not exists metric_tier text check (metric_tier in ('key', 'critical'));
