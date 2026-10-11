CREATE TABLE `commander_inbox_items` (
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
	CONSTRAINT "commander_inbox_kind" CHECK("commander_inbox_items"."kind" IN ('decision', 'hands', 'merge')),
	CONSTRAINT "commander_inbox_status" CHECK("commander_inbox_items"."status" IN ('open', 'closed')),
	CONSTRAINT "commander_inbox_close_reason" CHECK("commander_inbox_items"."close_reason" IN ('merged', 'pullRequestClosed', 'resolved', 'dismissed')),
	CONSTRAINT "commander_inbox_stale_reason" CHECK("commander_inbox_items"."stale_reason" IN ('headMoved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commander_inbox_open_key` ON `commander_inbox_items` (`kind`,`dedup_key`) WHERE "commander_inbox_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX `commander_inbox_status_updated` ON `commander_inbox_items` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `commander_inbox_replies` (
	`item_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `sequence`),
	FOREIGN KEY (`item_id`) REFERENCES `commander_inbox_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "commander_inbox_reply_source" CHECK("commander_inbox_replies"."source" IN ('desktop', 'mobile'))
);
