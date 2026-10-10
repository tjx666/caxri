CREATE TABLE `agent_session_usage` (
	`provider` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`terminal_id` text NOT NULL,
	`cwd` text NOT NULL,
	`bound_at` integer NOT NULL,
	`source_fingerprint` text,
	`scanned_at` integer,
	`usage_json` text,
	PRIMARY KEY(`provider`, `agent_session_id`)
);
--> statement-breakpoint
CREATE INDEX `agent_session_usage_session` ON `agent_session_usage` (`session_id`);--> statement-breakpoint
CREATE TABLE `pull_request_outcomes` (
	`url` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer,
	`merged_at` integer,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`checked_at` integer NOT NULL,
	CONSTRAINT "pull_request_outcomes_state" CHECK("pull_request_outcomes"."state" IN ('open', 'merged', 'closed', 'missing'))
);
