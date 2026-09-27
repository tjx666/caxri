CREATE TABLE `agent_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`terminal_id` text,
	`record_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_delegations_status" CHECK("agent_delegations"."status" IN ('requested', 'launching', 'awaiting_ready', 'submitting', 'running', 'collecting', 'completed', 'blocked', 'human_intervened', 'interrupted', 'failed', 'answer_unavailable'))
);
--> statement-breakpoint
CREATE INDEX `agent_delegations_session` ON `agent_delegations` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_delegations_status` ON `agent_delegations` (`status`);--> statement-breakpoint
CREATE INDEX `agent_delegations_terminal` ON `agent_delegations` (`terminal_id`);--> statement-breakpoint
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
	`updated_at` integer NOT NULL,
	CONSTRAINT "agent_dispatch_operation" CHECK("agent_dispatch_receipts"."operation" IN ('start', 'resume', 'wake')),
	CONSTRAINT "agent_dispatch_status" CHECK("agent_dispatch_receipts"."status" IN ('requested', 'starting', 'running', 'stopped', 'interrupted', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `agent_dispatch_project_updated` ON `agent_dispatch_receipts` (`project_id`,`updated_at`,`dispatch_id`);--> statement-breakpoint
CREATE INDEX `agent_dispatch_terminal_updated` ON `agent_dispatch_receipts` (`terminal_id`,`updated_at`,`dispatch_id`);--> statement-breakpoint
CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mobile_agent_submit_receipts` (
	`device_id` text NOT NULL,
	`device_generation` integer NOT NULL,
	`client_mutation_id` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `device_generation`, `client_mutation_id`),
	CONSTRAINT "mobile_agent_submit_status" CHECK("mobile_agent_submit_receipts"."status" IN ('reserved', 'accepted'))
);
--> statement-breakpoint
CREATE INDEX `mobile_agent_submit_created` ON `mobile_agent_submit_receipts` (`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`display_title` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`icon_name` text,
	`icon_color` text,
	`owner_project_id` text,
	`hidden_at` integer,
	FOREIGN KEY (`owner_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_order` ON `projects` (`order_index`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `projects_owner` ON `projects` (`owner_project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_path_unique` ON `projects` (`root_path`);--> statement-breakpoint
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
	`created_at` integer NOT NULL,
	CONSTRAINT "protocol_identity_singleton" CHECK("protocol_identity"."singleton" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_identity_server_id_unique` ON `protocol_identity` (`server_id`);--> statement-breakpoint
CREATE TABLE `session_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state_version` integer DEFAULT 2 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`workbench_state_json` text DEFAULT '{}' NOT NULL,
	`desired_secondary_sidebar_view_container_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workbench_project_id` text,
	`workbench_root_device` text,
	`workbench_root_inode` text,
	`created_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`last_session_activity_at` integer NOT NULL,
	`sidebar_order` integer DEFAULT 0 NOT NULL,
	`last_session_activity_reason` text DEFAULT 'created' NOT NULL,
	`archived_at` integer,
	`pinned_at` integer,
	`pinned_order` integer DEFAULT 0 NOT NULL,
	`primary_agent_terminal_id` text,
	`last_activity_state` text DEFAULT 'idle' NOT NULL,
	`attention_epoch` integer DEFAULT 0 NOT NULL,
	`read_attention_epoch` integer DEFAULT 0 NOT NULL,
	`last_attention_kind` text,
	`display_title` text NOT NULL,
	`title_mode` text DEFAULT 'automatic' NOT NULL,
	`automatic_naming` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workbench_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`primary_agent_terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sessions_last_activity_state" CHECK("sessions"."last_activity_state" IN ('running', 'waiting', 'completed', 'failed', 'idle', 'unknown')),
	CONSTRAINT "sessions_last_attention_kind" CHECK("sessions"."last_attention_kind" IN ('waiting', 'completed', 'failed')),
	CONSTRAINT "sessions_last_session_activity_reason" CHECK("sessions"."last_session_activity_reason" IN ('created', 'user_submission', 'agent_started', 'agent_waiting', 'agent_completed', 'agent_failed')),
	CONSTRAINT "sessions_title_mode" CHECK("sessions"."title_mode" IN ('automatic', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `sessions_project_created` ON `sessions` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_workbench_project` ON `sessions` (`workbench_project_id`);--> statement-breakpoint
CREATE TABLE `terminal_snapshots` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`encoding_version` integer NOT NULL,
	`cols` integer NOT NULL,
	`rows` integer NOT NULL,
	`line_count` integer NOT NULL,
	`byte_count` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text,
	`cwd` text NOT NULL,
	`agent_cwd` text,
	`title` text NOT NULL,
	`pty_title` text,
	`icon` text NOT NULL,
	`order_index` integer NOT NULL,
	`agent_session_id` text,
	`last_agent_process_state` text,
	`last_process_state` text NOT NULL,
	`failure_reason` text,
	`failure_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "terminals_last_process_state" CHECK("terminals"."last_process_state" IN ('starting', 'running', 'stopped', 'dead', 'failed', 'interrupted', 'suspended', 'detached')),
	CONSTRAINT "terminals_last_agent_process_state" CHECK("terminals"."last_agent_process_state" IN ('starting', 'running', 'stopped', 'dead', 'failed', 'interrupted', 'suspended', 'detached')),
	CONSTRAINT "terminals_failure_reason" CHECK("terminals"."failure_reason" IN ('working_directory_unavailable', 'executable_not_found', 'spawn_failed', 'agent_session_unavailable')),
	CONSTRAINT "terminals_failure_reason_state" CHECK("terminals"."failure_reason" IS NULL OR "terminals"."last_process_state" = 'failed')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminals_session_order` ON `terminals` (`session_id`,`order_index`);