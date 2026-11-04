CREATE TABLE `delegation_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`child_launch_id` text NOT NULL,
	`child_generation` integer NOT NULL,
	`request_id` text,
	`question_text` text NOT NULL,
	`options_json` text,
	`state` text NOT NULL,
	`answered_by` text,
	`answer_text` text,
	`cancel_reason` text,
	`asked_at` integer NOT NULL,
	`escalated_at` integer,
	`escalation_reason` text,
	`closed_at` integer,
	FOREIGN KEY (`delegation_id`) REFERENCES `agent_delegations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delegation_questions_state" CHECK("delegation_questions"."state" IN ('open', 'answered', 'cancelled')),
	CONSTRAINT "delegation_questions_answered_by" CHECK("delegation_questions"."answered_by" IN ('parent', 'user')),
	CONSTRAINT "delegation_questions_cancel_reason" CHECK("delegation_questions"."cancel_reason" IN ('child_cancelled', 'taken_over', 'host_reset', 'task_ended')),
	CONSTRAINT "delegation_questions_escalation_reason" CHECK("delegation_questions"."escalation_reason" IN ('grace_elapsed', 'parent_gone')),
	CONSTRAINT "delegation_questions_closed_state" CHECK(("delegation_questions"."state" = 'open' AND "delegation_questions"."answered_by" IS NULL AND "delegation_questions"."cancel_reason" IS NULL AND "delegation_questions"."closed_at" IS NULL) OR ("delegation_questions"."state" = 'answered' AND "delegation_questions"."answered_by" IS NOT NULL AND "delegation_questions"."answer_text" IS NOT NULL AND "delegation_questions"."cancel_reason" IS NULL AND "delegation_questions"."closed_at" IS NOT NULL) OR ("delegation_questions"."state" = 'cancelled' AND "delegation_questions"."cancel_reason" IS NOT NULL AND "delegation_questions"."answered_by" IS NULL AND "delegation_questions"."closed_at" IS NOT NULL)),
	CONSTRAINT "delegation_questions_escalation" CHECK(("delegation_questions"."escalated_at" IS NULL) = ("delegation_questions"."escalation_reason" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `delegation_questions_delegation` ON `delegation_questions` (`delegation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_questions_open_key` ON `delegation_questions` (`delegation_id`) WHERE "delegation_questions"."state" = 'open';