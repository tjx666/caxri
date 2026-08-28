DROP INDEX `sessions_project_activity`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_session_activity_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_session_activity_reason` text DEFAULT 'created' NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_project_activity` ON `sessions` (`project_id`,"last_session_activity_at" DESC);