CREATE TABLE `agent_chat_versions` (
	`terminal_id` text NOT NULL,
	`id` text NOT NULL,
	`agent_session_id` text,
	`parent_version_id` text,
	`anchor_turn_id` text,
	`items_json` text NOT NULL,
	`turns_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`terminal_id`, `id`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_chat_versions_terminal` ON `agent_chat_versions` (`terminal_id`,`created_at`);