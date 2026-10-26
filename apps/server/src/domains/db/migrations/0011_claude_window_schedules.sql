CREATE TABLE `claude_window_schedules` (
	`account_hash` text PRIMARY KEY NOT NULL,
	`plan_type` text,
	`keep_rolling` integer,
	`first_workday_reset_minutes` integer,
	`processed_through` integer,
	`observed_reset_at` integer,
	`triggered_reset_at` integer,
	`last_outcome` text,
	`last_outcome_at` integer,
	`missed_planned_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "claude_window_schedules_outcome" CHECK("claude_window_schedules"."last_outcome" IN ('natural_window_started', 'trigger_confirmed', 'trigger_unverified', 'trigger_failed', 'renewal_skipped', 'weekly_limit', 'auth_unsupported', 'missed_while_asleep'))
);
