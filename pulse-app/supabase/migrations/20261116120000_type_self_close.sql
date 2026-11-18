-- Does work of this task type close without review (Settings › Tasks & time ›
-- Self close)? On: whoever did it moves it to Completed themselves, with no
-- reviewer (Schedule work, say). Off, the default: it goes to Review.
-- Types that don't count in goals closed themselves until now, so the update
-- turns it on for them. Run it once: run again, the update would turn it back
-- on for an off-goal type someone has since switched off.

alter table public.task_content_format add column if not exists self_close boolean not null default false;
update public.task_content_format set self_close = true where counts_in_goal = false and not self_close;
