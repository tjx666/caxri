CREATE TABLE `agent_chat_answered_notices` (
	`terminal_id` text NOT NULL,
	`item_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`after_item_id` text,
	`item_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`terminal_id`, `item_id`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_chat_answered_notices_terminal` ON `agent_chat_answered_notices` (`terminal_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_chat_process_groups` (
	`pgid` integer PRIMARY KEY NOT NULL,
	`terminal_id` text NOT NULL,
	`leader_started_at` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `terminals` ADD `agent_resume_at` text;