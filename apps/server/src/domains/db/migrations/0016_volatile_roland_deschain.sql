CREATE TABLE `protocol_changefeed` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state_epoch` text NOT NULL,
	`event_name` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `protocol_changefeed_epoch_sequence` ON `protocol_changefeed` (`state_epoch`,`sequence`);--> statement-breakpoint
CREATE TABLE `protocol_command_receipts` (
	`state_epoch` text NOT NULL,
	`client_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`method` text NOT NULL,
	`reply_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`state_epoch`, `client_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `protocol_command_receipts_created` ON `protocol_command_receipts` (`created_at`);--> statement-breakpoint
CREATE TABLE `protocol_identity` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`state_epoch` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_identity_server_id_unique` ON `protocol_identity` (`server_id`);