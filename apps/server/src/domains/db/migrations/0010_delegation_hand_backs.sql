CREATE TABLE `delegation_hand_backs` (
	`id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`terminal_id` text NOT NULL,
	`launch_id` text NOT NULL,
	`provider_session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`input_epoch` integer NOT NULL,
	`caller_terminal_id` text NOT NULL,
	`caller_launch_id` text NOT NULL,
	`state` text NOT NULL,
	`consumed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`delegation_id`) REFERENCES `agent_delegations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delegation_hand_backs_state" CHECK("delegation_hand_backs"."state" IN ('pending', 'consumed', 'invalidated')),
	CONSTRAINT "delegation_hand_backs_consumed" CHECK(("delegation_hand_backs"."state" = 'consumed') = ("delegation_hand_backs"."consumed_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `delegation_hand_backs_session` ON `delegation_hand_backs` (`session_id`,`state`);--> statement-breakpoint
CREATE INDEX `delegation_hand_backs_terminal` ON `delegation_hand_backs` (`terminal_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_hand_backs_pending` ON `delegation_hand_backs` (`delegation_id`) WHERE "delegation_hand_backs"."state" = 'pending';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_delegation_notices` (
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
	CONSTRAINT "delegation_notices_kind" CHECK("__new_delegation_notices"."kind" IN ('settled', 'question', 'approval', 'handback')),
	CONSTRAINT "delegation_notices_state" CHECK("__new_delegation_notices"."state" IN ('pending', 'delivered', 'skipped', 'unknown')),
	CONSTRAINT "delegation_notices_subject" CHECK(("__new_delegation_notices"."kind" = 'settled') = ("__new_delegation_notices"."subject_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_delegation_notices`("id", "delegation_id", "kind", "subject_id", "state", "caller_terminal_id", "caller_launch_id", "created_at", "updated_at", "acknowledged_at") SELECT "id", "delegation_id", "kind", "subject_id", "state", "caller_terminal_id", "caller_launch_id", "created_at", "updated_at", "acknowledged_at" FROM `delegation_notices`;--> statement-breakpoint
DROP TABLE `delegation_notices`;--> statement-breakpoint
ALTER TABLE `__new_delegation_notices` RENAME TO `delegation_notices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `delegation_notices_delegation` ON `delegation_notices` (`delegation_id`);--> statement-breakpoint
CREATE INDEX `delegation_notices_caller` ON `delegation_notices` (`caller_terminal_id`,`state`);