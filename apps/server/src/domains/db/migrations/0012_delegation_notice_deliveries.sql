CREATE TABLE `delegation_notice_deliveries` (
	`terminal_id` text NOT NULL,
	`digest` text NOT NULL,
	`items_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`terminal_id`, `digest`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delegation_notice_deliveries_terminal` ON `delegation_notice_deliveries` (`terminal_id`,`created_at`);