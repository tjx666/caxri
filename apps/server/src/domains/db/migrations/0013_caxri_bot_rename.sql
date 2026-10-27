ALTER TABLE `commander_inbox_items` RENAME TO `bot_inbox_items`;--> statement-breakpoint
ALTER TABLE `commander_inbox_replies` RENAME TO `bot_inbox_replies`;--> statement-breakpoint
ALTER TABLE `commander_pending_notices` RENAME TO `bot_pending_notices`;--> statement-breakpoint
ALTER TABLE `commander_tasks` RENAME TO `bot_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bot_inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedup_key` text,
	`status` text NOT NULL,
	`close_reason` text,
	`stale_reason` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`session_id` text,
	`delegation_id` text,
	`pull_request_url` text,
	`pull_request_head_sha` text,
	`acknowledged_sequence` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "bot_inbox_kind" CHECK("__new_bot_inbox_items"."kind" IN ('decision', 'hands', 'merge')),
	CONSTRAINT "bot_inbox_status" CHECK("__new_bot_inbox_items"."status" IN ('open', 'closed')),
	CONSTRAINT "bot_inbox_close_reason" CHECK("__new_bot_inbox_items"."close_reason" IN ('merged', 'pullRequestClosed', 'resolved', 'dismissed')),
	CONSTRAINT "bot_inbox_stale_reason" CHECK("__new_bot_inbox_items"."stale_reason" IN ('headMoved'))
);
--> statement-breakpoint
INSERT INTO `__new_bot_inbox_items`("id", "kind", "dedup_key", "status", "close_reason", "stale_reason", "title", "body", "options_json", "session_id", "delegation_id", "pull_request_url", "pull_request_head_sha", "acknowledged_sequence", "revision", "created_at", "updated_at", "closed_at") SELECT "id", "kind", "dedup_key", "status", "close_reason", "stale_reason", "title", "body", "options_json", "session_id", "delegation_id", "pull_request_url", "pull_request_head_sha", "acknowledged_sequence", "revision", "created_at", "updated_at", "closed_at" FROM `bot_inbox_items`;--> statement-breakpoint
DROP TABLE `bot_inbox_items`;--> statement-breakpoint
ALTER TABLE `__new_bot_inbox_items` RENAME TO `bot_inbox_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `bot_inbox_open_key` ON `bot_inbox_items` (`kind`,`dedup_key`) WHERE "bot_inbox_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX `bot_inbox_status_updated` ON `bot_inbox_items` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_bot_inbox_replies` (
	`item_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `sequence`),
	FOREIGN KEY (`item_id`) REFERENCES `bot_inbox_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bot_inbox_reply_source" CHECK("__new_bot_inbox_replies"."source" IN ('desktop', 'mobile'))
);
--> statement-breakpoint
INSERT INTO `__new_bot_inbox_replies`("item_id", "sequence", "body", "source", "created_at") SELECT "item_id", "sequence", "body", "source", "created_at" FROM `bot_inbox_replies`;--> statement-breakpoint
DROP TABLE `bot_inbox_replies`;--> statement-breakpoint
ALTER TABLE `__new_bot_inbox_replies` RENAME TO `bot_inbox_replies`;--> statement-breakpoint
CREATE TABLE `__new_bot_pending_notices` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`delegation_id` text,
	`session_id` text,
	`status` text,
	`revision` integer,
	`queued_at` integer NOT NULL,
	CONSTRAINT "bot_pending_notices_kind" CHECK("__new_bot_pending_notices"."kind" IN ('delegation', 'interrupted_turn')),
	CONSTRAINT "bot_pending_notices_status" CHECK("__new_bot_pending_notices"."status" IN ('completed', 'failed', 'needsInput'))
);
--> statement-breakpoint
INSERT INTO `__new_bot_pending_notices`("key", "kind", "delegation_id", "session_id", "status", "revision", "queued_at") SELECT "key", "kind", "delegation_id", "session_id", "status", "revision", "queued_at" FROM `bot_pending_notices`;--> statement-breakpoint
DROP TABLE `bot_pending_notices`;--> statement-breakpoint
ALTER TABLE `__new_bot_pending_notices` RENAME TO `bot_pending_notices`;--> statement-breakpoint
CREATE TABLE `__new_bot_tasks` (
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
	CONSTRAINT "bot_tasks_status" CHECK("__new_bot_tasks"."status" IN ('pending', 'dispatched', 'waiting_user', 'done', 'dropped'))
);
--> statement-breakpoint
INSERT INTO `__new_bot_tasks`("id", "title", "status", "project_id", "session_id", "delegation_id", "note", "pull_request_url", "created_at", "updated_at") SELECT "id", "title", "status", "project_id", "session_id", "delegation_id", "note", "pull_request_url", "created_at", "updated_at" FROM `bot_tasks`;--> statement-breakpoint
DROP TABLE `bot_tasks`;--> statement-breakpoint
ALTER TABLE `__new_bot_tasks` RENAME TO `bot_tasks`;--> statement-breakpoint
CREATE INDEX `bot_tasks_status` ON `bot_tasks` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `bot_tasks_delegation` ON `bot_tasks` (`delegation_id`);