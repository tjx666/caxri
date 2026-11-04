CREATE TABLE `delegation_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text,
	`state` text NOT NULL,
	`caller_terminal_id` text NOT NULL,
	`caller_launch_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`acknowledged_at` integer,
	FOREIGN KEY (`delegation_id`) REFERENCES `agent_delegations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delegation_notices_kind" CHECK("delegation_notices"."kind" IN ('settled', 'question', 'approval')),
	CONSTRAINT "delegation_notices_state" CHECK("delegation_notices"."state" IN ('pending', 'delivered', 'skipped', 'unknown')),
	CONSTRAINT "delegation_notices_subject" CHECK(("delegation_notices"."kind" = 'settled') = ("delegation_notices"."subject_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `delegation_notices_delegation` ON `delegation_notices` (`delegation_id`);--> statement-breakpoint
CREATE INDEX `delegation_notices_caller` ON `delegation_notices` (`caller_terminal_id`,`state`);