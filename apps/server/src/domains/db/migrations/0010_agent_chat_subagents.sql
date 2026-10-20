CREATE TABLE `agent_chat_subagents` (
	`terminal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`agent_type` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	PRIMARY KEY(`terminal_id`, `task_id`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_chat_subagents_status" CHECK("agent_chat_subagents"."status" IN ('running', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `agent_chat_subagents_terminal` ON `agent_chat_subagents` (`terminal_id`,`started_at`);