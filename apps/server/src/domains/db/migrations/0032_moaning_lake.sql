CREATE TABLE `mobile_agent_submit_receipts` (
	`device_id` text NOT NULL,
	`device_generation` integer NOT NULL,
	`client_mutation_id` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `device_generation`, `client_mutation_id`)
);
--> statement-breakpoint
CREATE INDEX `mobile_agent_submit_created` ON `mobile_agent_submit_receipts` (`created_at`);