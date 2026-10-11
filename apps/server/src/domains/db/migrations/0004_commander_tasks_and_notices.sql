CREATE TABLE `commander_pending_notices` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`delegation_id` text,
	`session_id` text,
	`status` text,
	`revision` integer,
	`queued_at` integer NOT NULL,
	CONSTRAINT "commander_pending_notices_kind" CHECK("commander_pending_notices"."kind" IN ('delegation', 'interrupted_turn')),
	CONSTRAINT "commander_pending_notices_status" CHECK("commander_pending_notices"."status" IN ('completed', 'failed', 'needsInput'))
);
--> statement-breakpoint
CREATE TABLE `commander_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`project_id` text,
	`session_id` text,
	`delegation_id` text,
	`note` text,
	`pull_request_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "commander_tasks_status" CHECK("commander_tasks"."status" IN ('pending', 'dispatched', 'waiting_user', 'done', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX `commander_tasks_status` ON `commander_tasks` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `commander_tasks_delegation` ON `commander_tasks` (`delegation_id`);