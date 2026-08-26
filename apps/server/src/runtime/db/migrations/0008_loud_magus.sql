CREATE TABLE `agent_dispatch_receipts` (
	`dispatch_id` text PRIMARY KEY NOT NULL,
	`request_fingerprint` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`terminal_id` text,
	`provider` text NOT NULL,
	`requested_launch_json` text NOT NULL,
	`effective_launch_json` text NOT NULL,
	`endpoint_json` text,
	`failure_json` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_dispatch_project_updated` ON `agent_dispatch_receipts` (`project_id`,`updated_at`,`dispatch_id`);--> statement-breakpoint
CREATE INDEX `agent_dispatch_terminal_updated` ON `agent_dispatch_receipts` (`terminal_id`,`updated_at`,`dispatch_id`);