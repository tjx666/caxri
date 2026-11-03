PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workbench_root_project_id` text,
	`workbench_root_device` text,
	`workbench_root_inode` text,
	`created_at` integer NOT NULL,
	`last_visited_at` integer NOT NULL,
	`session_activity_at` integer NOT NULL,
	`sidebar_order` integer DEFAULT 0 NOT NULL,
	`session_activity_reason` text NOT NULL,
	`archived_at` integer,
	`pinned_at` integer,
	`pinned_order` integer DEFAULT 0 NOT NULL,
	`primary_agent_terminal_id` text,
	`agent_activity_state` text DEFAULT 'idle' NOT NULL,
	`attention_generation` integer DEFAULT 0 NOT NULL,
	`acknowledged_attention_generation` integer DEFAULT 0 NOT NULL,
	`last_attention_kind` text,
	`last_viewed_at` integer,
	`title` text NOT NULL,
	`title_mode` text DEFAULT 'automatic' NOT NULL,
	`created_by_session_id` text,
	`created_by_relation` text,
	`automatic_naming_json` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workbench_root_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`primary_agent_terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sessions_agent_activity_state" CHECK("__new_sessions"."agent_activity_state" IN ('running', 'waiting', 'completed', 'failed', 'idle', 'unknown')),
	CONSTRAINT "sessions_last_attention_kind" CHECK("__new_sessions"."last_attention_kind" IN ('waiting', 'completed', 'failed')),
	CONSTRAINT "sessions_session_activity_reason" CHECK("__new_sessions"."session_activity_reason" IN ('created', 'user_submission', 'agent_started', 'agent_waiting', 'agent_completed', 'agent_failed')),
	CONSTRAINT "sessions_title_mode" CHECK("__new_sessions"."title_mode" IN ('automatic', 'manual')),
	CONSTRAINT "sessions_created_by_relation" CHECK("__new_sessions"."created_by_relation" IN ('delegated', 'handoff', 'consult'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "project_id", "workbench_root_project_id", "workbench_root_device", "workbench_root_inode", "created_at", "last_visited_at", "session_activity_at", "sidebar_order", "session_activity_reason", "archived_at", "pinned_at", "pinned_order", "primary_agent_terminal_id", "agent_activity_state", "attention_generation", "acknowledged_attention_generation", "last_attention_kind", "last_viewed_at", "title", "title_mode", "created_by_session_id", "created_by_relation", "automatic_naming_json") SELECT "id", "project_id", "workbench_root_project_id", "workbench_root_device", "workbench_root_inode", "created_at", "last_visited_at", "session_activity_at", "sidebar_order", "session_activity_reason", "archived_at", "pinned_at", "pinned_order", "primary_agent_terminal_id", "agent_activity_state", "attention_generation", "acknowledged_attention_generation", "last_attention_kind", "last_viewed_at", "title", "title_mode", "created_by_session_id", "created_by_relation", "automatic_naming_json" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sessions_project_created` ON `sessions` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_workbench_root_project` ON `sessions` (`workbench_root_project_id`);--> statement-breakpoint
CREATE INDEX `sessions_primary_agent_terminal` ON `sessions` (`primary_agent_terminal_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_by` ON `sessions` (`created_by_session_id`);