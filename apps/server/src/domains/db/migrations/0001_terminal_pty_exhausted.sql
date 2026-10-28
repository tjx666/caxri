PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text GENERATED ALWAYS AS (CASE WHEN kind = 'shell' THEN NULL ELSE kind END) VIRTUAL,
	`cwd` text NOT NULL,
	`agent_cwd` text,
	`title` text NOT NULL,
	`pty_title` text,
	`order_index` integer NOT NULL,
	`agent_session_id` text,
	`last_agent_process_state` text,
	`last_process_state` text NOT NULL,
	`failure_reason` text,
	`failure_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`surface` text DEFAULT 'pty' NOT NULL,
	`chat_permission_mode` text,
	`chat_plan_mode` integer,
	`chat_resume_record_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "terminals_last_process_state" CHECK("__new_terminals"."last_process_state" IN ('starting', 'running', 'stopped', 'dead', 'failed', 'interrupted', 'suspended', 'detached')),
	CONSTRAINT "terminals_last_agent_process_state" CHECK("__new_terminals"."last_agent_process_state" IN ('starting', 'running', 'stopped', 'dead', 'failed', 'interrupted', 'suspended', 'detached')),
	CONSTRAINT "terminals_failure_reason" CHECK("__new_terminals"."failure_reason" IN ('working_directory_unavailable', 'executable_not_found', 'spawn_failed', 'agent_session_unavailable', 'pty_exhausted')),
	CONSTRAINT "terminals_failure_reason_state" CHECK("__new_terminals"."failure_reason" IS NULL OR "__new_terminals"."last_process_state" = 'failed'),
	CONSTRAINT "terminals_surface" CHECK("__new_terminals"."surface" IN ('pty', 'chat')),
	CONSTRAINT "terminals_chat_permission_mode" CHECK("__new_terminals"."chat_permission_mode" IN ('readOnly', 'ask', 'acceptEdits', 'auto', 'fullAccess')),
	CONSTRAINT "terminals_chat_plan_mode" CHECK("__new_terminals"."chat_plan_mode" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_terminals`("id", "session_id", "kind", "cwd", "agent_cwd", "title", "pty_title", "order_index", "agent_session_id", "last_agent_process_state", "last_process_state", "failure_reason", "failure_detail", "created_at", "updated_at", "surface", "chat_permission_mode", "chat_plan_mode", "chat_resume_record_id") SELECT "id", "session_id", "kind", "cwd", "agent_cwd", "title", "pty_title", "order_index", "agent_session_id", "last_agent_process_state", "last_process_state", "failure_reason", "failure_detail", "created_at", "updated_at", "surface", "chat_permission_mode", "chat_plan_mode", "chat_resume_record_id" FROM `terminals`;--> statement-breakpoint
DROP TABLE `terminals`;--> statement-breakpoint
ALTER TABLE `__new_terminals` RENAME TO `terminals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `terminals_session_order` ON `terminals` (`session_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `terminals_agent_session` ON `terminals` (`agent_session_id`);