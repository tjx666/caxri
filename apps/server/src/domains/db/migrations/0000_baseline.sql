CREATE TABLE `agent_chat_answered_notices` (
	`terminal_id` text NOT NULL,
	`item_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`after_item_id` text,
	`item_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`terminal_id`, `item_id`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_chat_answered_notices_terminal` ON `agent_chat_answered_notices` (`terminal_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_chat_process_groups` (
	`pgid` integer PRIMARY KEY NOT NULL,
	`terminal_id` text NOT NULL,
	`leader_start_token` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_chat_subagents` (
	`terminal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`agent_type` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	PRIMARY KEY(`terminal_id`, `task_id`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_chat_subagents_status" CHECK("agent_chat_subagents"."status" IN ('running', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `agent_chat_subagents_terminal` ON `agent_chat_subagents` (`terminal_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`document_json` text NOT NULL,
	CONSTRAINT "benchmark_run_status" CHECK("benchmark_runs"."status" IN ('running', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `benchmark_runs_created` ON `benchmark_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `bot_inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedup_key` text,
	`status` text NOT NULL,
	`close_reason` text,
	`stale_reason` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`session_id` text,
	`delegation_id` text,
	`pull_request_url` text,
	`pull_request_head_sha` text,
	`acknowledged_sequence` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "bot_inbox_kind" CHECK("bot_inbox_items"."kind" IN ('decision', 'hands', 'merge')),
	CONSTRAINT "bot_inbox_status" CHECK("bot_inbox_items"."status" IN ('open', 'closed')),
	CONSTRAINT "bot_inbox_close_reason" CHECK("bot_inbox_items"."close_reason" IN ('merged', 'pullRequestClosed', 'resolved', 'dismissed')),
	CONSTRAINT "bot_inbox_stale_reason" CHECK("bot_inbox_items"."stale_reason" IN ('headMoved')),
	CONSTRAINT "bot_inbox_closed_state" CHECK(("bot_inbox_items"."status" = 'open' AND "bot_inbox_items"."close_reason" IS NULL AND "bot_inbox_items"."closed_at" IS NULL) OR ("bot_inbox_items"."status" = 'closed' AND "bot_inbox_items"."close_reason" IS NOT NULL AND "bot_inbox_items"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_inbox_open_key` ON `bot_inbox_items` (`kind`,`dedup_key`) WHERE "bot_inbox_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX `bot_inbox_status_updated` ON `bot_inbox_items` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `bot_inbox_replies` (
	`item_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `sequence`),
	FOREIGN KEY (`item_id`) REFERENCES `bot_inbox_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bot_inbox_reply_source" CHECK("bot_inbox_replies"."source" IN ('desktop', 'mobile'))
);
--> statement-breakpoint
CREATE TABLE `bot_pending_notices` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`delegation_id` text,
	`session_id` text,
	`status` text,
	`revision` integer,
	`queued_at` integer NOT NULL,
	CONSTRAINT "bot_pending_notices_kind" CHECK("bot_pending_notices"."kind" IN ('delegation', 'interrupted_turn')),
	CONSTRAINT "bot_pending_notices_status" CHECK("bot_pending_notices"."status" IN ('completed', 'failed', 'needsInput')),
	CONSTRAINT "bot_pending_notices_shape" CHECK(("bot_pending_notices"."kind" = 'delegation' AND "bot_pending_notices"."delegation_id" IS NOT NULL AND "bot_pending_notices"."session_id" IS NOT NULL AND "bot_pending_notices"."status" IS NOT NULL AND "bot_pending_notices"."revision" IS NOT NULL) OR ("bot_pending_notices"."kind" = 'interrupted_turn' AND "bot_pending_notices"."delegation_id" IS NULL AND "bot_pending_notices"."session_id" IS NULL AND "bot_pending_notices"."status" IS NULL AND "bot_pending_notices"."revision" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `bot_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`project_id` text,
	`session_id` text,
	`delegation_id` text,
	`note` text,
	`pull_request_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "bot_tasks_status" CHECK("bot_tasks"."status" IN ('pending', 'dispatched', 'waiting_user', 'done', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX `bot_tasks_status` ON `bot_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `bot_tasks_project` ON `bot_tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `bot_tasks_session` ON `bot_tasks` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bot_tasks_delegation` ON `bot_tasks` (`delegation_id`);--> statement-breakpoint
CREATE TABLE `claude_window_schedules` (
	`account_hash` text PRIMARY KEY NOT NULL,
	`plan_type` text,
	`keep_rolling` integer,
	`first_workday_reset_minutes` integer,
	`processed_through_at` integer,
	`observed_reset_at` integer,
	`triggered_reset_at` integer,
	`last_outcome` text,
	`last_outcome_at` integer,
	`missed_planned_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "claude_window_schedules_outcome" CHECK("claude_window_schedules"."last_outcome" IN ('natural_window_started', 'trigger_confirmed', 'trigger_unverified', 'trigger_failed', 'renewal_skipped', 'weekly_limit', 'auth_unsupported', 'missed_while_asleep')),
	CONSTRAINT "claude_window_schedules_keep_rolling" CHECK("claude_window_schedules"."keep_rolling" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `agent_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text GENERATED ALWAYS AS (json_extract(record_json, '$.receipt.status')) STORED NOT NULL,
	`terminal_id` text GENERATED ALWAYS AS (json_extract(record_json, '$.receipt.terminalId')) STORED,
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
CREATE INDEX `agent_dispatch_terminal_created` ON `agent_dispatch_receipts` (`terminal_id`,`created_at`,`dispatch_id`);--> statement-breakpoint
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
	`title` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_visited_at` integer NOT NULL,
	`icon_name` text,
	`icon_color` text,
	`owner_project_id` text,
	`hidden_at` integer,
	`chat_defaults_json` text,
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
CREATE TABLE `session_views` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state_version` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`roots_json` text DEFAULT '{}' NOT NULL,
	`desired_secondary_sidebar_view_container_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
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
	`automatic_naming_json` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workbench_root_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`primary_agent_terminal_id`) REFERENCES `terminals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sessions_agent_activity_state" CHECK("sessions"."agent_activity_state" IN ('running', 'waiting', 'completed', 'failed', 'idle', 'unknown')),
	CONSTRAINT "sessions_last_attention_kind" CHECK("sessions"."last_attention_kind" IN ('waiting', 'completed', 'failed')),
	CONSTRAINT "sessions_session_activity_reason" CHECK("sessions"."session_activity_reason" IN ('created', 'user_submission', 'agent_started', 'agent_waiting', 'agent_completed', 'agent_failed')),
	CONSTRAINT "sessions_title_mode" CHECK("sessions"."title_mode" IN ('automatic', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `sessions_project_created` ON `sessions` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_workbench_root_project` ON `sessions` (`workbench_root_project_id`);--> statement-breakpoint
CREATE INDEX `sessions_primary_agent_terminal` ON `sessions` (`primary_agent_terminal_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_by` ON `sessions` (`created_by_session_id`);--> statement-breakpoint
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
	CONSTRAINT "terminals_last_process_state" CHECK("terminals"."last_process_state" IN ('starting', 'running', 'stopped', 'dead', 'failed', 'interrupted', 'suspended', 'detached')),
	CONSTRAINT "terminals_last_agent_process_state" CHECK("terminals"."last_agent_process_state" IN ('starting', 'running', 'stopped', 'dead', 'failed', 'interrupted', 'suspended', 'detached')),
	CONSTRAINT "terminals_failure_reason" CHECK("terminals"."failure_reason" IN ('working_directory_unavailable', 'executable_not_found', 'spawn_failed', 'agent_session_unavailable')),
	CONSTRAINT "terminals_failure_reason_state" CHECK("terminals"."failure_reason" IS NULL OR "terminals"."last_process_state" = 'failed'),
	CONSTRAINT "terminals_surface" CHECK("terminals"."surface" IN ('pty', 'chat')),
	CONSTRAINT "terminals_chat_permission_mode" CHECK("terminals"."chat_permission_mode" IN ('readOnly', 'ask', 'acceptEdits', 'auto', 'fullAccess')),
	CONSTRAINT "terminals_chat_plan_mode" CHECK("terminals"."chat_plan_mode" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminals_session_order` ON `terminals` (`session_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `terminals_agent_session` ON `terminals` (`agent_session_id`);--> statement-breakpoint
CREATE TABLE `delegation_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`caller_provider` text NOT NULL,
	`token_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `mobile_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`platform` text NOT NULL,
	`credential` text NOT NULL,
	`generation` integer NOT NULL,
	`role` text NOT NULL,
	`project_ids_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_connected_at` integer,
	`revoked_at` integer,
	CONSTRAINT "mobile_devices_platform" CHECK("mobile_devices"."platform" IN ('android', 'ios')),
	CONSTRAINT "mobile_devices_role" CHECK("mobile_devices"."role" IN ('view', 'reply', 'control'))
);
--> statement-breakpoint
CREATE TABLE `agent_session_usage` (
	`provider` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`terminal_id` text NOT NULL,
	`cwd` text NOT NULL,
	`bound_at` integer NOT NULL,
	`source_fingerprint` text,
	`scanned_at` integer,
	`usage_json` text,
	PRIMARY KEY(`provider`, `agent_session_id`)
);
--> statement-breakpoint
CREATE INDEX `agent_session_usage_session` ON `agent_session_usage` (`session_id`);--> statement-breakpoint
CREATE TABLE `external_agent_usage` (
	`provider` text NOT NULL,
	`transcript_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`path` text NOT NULL,
	`cwd` text,
	`source_fingerprint` text NOT NULL,
	`scanned_at` integer NOT NULL,
	`usage_json` text NOT NULL,
	PRIMARY KEY(`provider`, `transcript_id`)
);
--> statement-breakpoint
CREATE TABLE `pull_request_outcomes` (
	`url` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`opened_at` integer,
	`merged_at` integer,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`checked_at` integer NOT NULL,
	CONSTRAINT "pull_request_outcomes_state" CHECK("pull_request_outcomes"."state" IN ('open', 'merged', 'closed', 'missing'))
);
