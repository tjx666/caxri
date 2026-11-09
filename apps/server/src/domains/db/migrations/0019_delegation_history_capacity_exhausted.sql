PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_delegation_history` (
	`delegation_id` text PRIMARY KEY NOT NULL,
	`root_delegation_id` text NOT NULL,
	`retry_of` text,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`owner_terminal_id` text,
	`owner_principal_hash` text,
	`owner_conversation_id` text,
	`provider` text NOT NULL,
	`selection_model` text,
	`selection_effort` text,
	`outcome` text NOT NULL,
	`failure` text,
	`title` text,
	`summary` text,
	`summary_source` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`reasoning_tokens` integer,
	`total_tokens` integer,
	`usage_scope` text,
	`created_at` integer NOT NULL,
	`settled_at` integer NOT NULL,
	`compacted_at` integer,
	CONSTRAINT "delegation_history_outcome" CHECK("__new_delegation_history"."outcome" IN ('completed', 'human_intervened', 'interrupted', 'failed', 'answer_unavailable')),
	CONSTRAINT "delegation_history_failure" CHECK("__new_delegation_history"."failure" IN ('rate_limited', 'authentication_failed', 'output_limit', 'startup_not_ready', 'startup_waiting', 'submission_unconfirmed', 'provider_failed', 'permission_required', 'target_changed', 'session_changed', 'human_input', 'host_reset', 'result_missing', 'payload_overflow', 'launch_failed', 'hooks_required', 'correlation_missing', 'quota_exhausted', 'caller_stopped', 'target_not_ready', 'target_busy', 'capacity_exhausted')),
	CONSTRAINT "delegation_history_summary_source" CHECK("__new_delegation_history"."summary_source" IN ('authored', 'excerpt')),
	CONSTRAINT "delegation_history_usage_scope" CHECK("__new_delegation_history"."usage_scope" IN ('main-thread', 'provider-task')),
	CONSTRAINT "delegation_history_outcome_failure" CHECK("__new_delegation_history"."outcome" <> 'completed' OR "__new_delegation_history"."failure" IS NULL),
	CONSTRAINT "delegation_history_summary_pair" CHECK(("__new_delegation_history"."summary" IS NULL) = ("__new_delegation_history"."summary_source" IS NULL)),
	CONSTRAINT "delegation_history_summary_completed" CHECK("__new_delegation_history"."summary" IS NULL OR "__new_delegation_history"."outcome" = 'completed'),
	CONSTRAINT "delegation_history_compacted_text" CHECK("__new_delegation_history"."compacted_at" IS NULL OR ("__new_delegation_history"."title" IS NULL AND "__new_delegation_history"."summary" IS NULL)),
	CONSTRAINT "delegation_history_settle_order" CHECK("__new_delegation_history"."settled_at" >= "__new_delegation_history"."created_at"),
	CONSTRAINT "delegation_history_scope_counters" CHECK("__new_delegation_history"."usage_scope" IS NULL OR "__new_delegation_history"."input_tokens" IS NOT NULL OR "__new_delegation_history"."output_tokens" IS NOT NULL),
	CONSTRAINT "delegation_history_tokens" CHECK(("__new_delegation_history"."input_tokens" IS NULL OR "__new_delegation_history"."input_tokens" >= 0) AND ("__new_delegation_history"."output_tokens" IS NULL OR "__new_delegation_history"."output_tokens" >= 0) AND ("__new_delegation_history"."cache_read_tokens" IS NULL OR "__new_delegation_history"."cache_read_tokens" >= 0) AND ("__new_delegation_history"."cache_write_tokens" IS NULL OR "__new_delegation_history"."cache_write_tokens" >= 0) AND ("__new_delegation_history"."reasoning_tokens" IS NULL OR "__new_delegation_history"."reasoning_tokens" >= 0) AND ("__new_delegation_history"."total_tokens" IS NULL OR "__new_delegation_history"."total_tokens" >= 0))
);
--> statement-breakpoint
INSERT INTO `__new_delegation_history`("delegation_id", "root_delegation_id", "retry_of", "session_id", "project_id", "owner_terminal_id", "owner_principal_hash", "owner_conversation_id", "provider", "selection_model", "selection_effort", "outcome", "failure", "title", "summary", "summary_source", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "usage_scope", "created_at", "settled_at", "compacted_at") SELECT "delegation_id", "root_delegation_id", "retry_of", "session_id", "project_id", "owner_terminal_id", "owner_principal_hash", "owner_conversation_id", "provider", "selection_model", "selection_effort", "outcome", "failure", "title", "summary", "summary_source", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "usage_scope", "created_at", "settled_at", "compacted_at" FROM `delegation_history`;--> statement-breakpoint
DROP TABLE `delegation_history`;--> statement-breakpoint
ALTER TABLE `__new_delegation_history` RENAME TO `delegation_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `delegation_history_owner_created` ON `delegation_history` (`owner_terminal_id`,"created_at" desc,"delegation_id" desc);--> statement-breakpoint
CREATE INDEX `delegation_history_created` ON `delegation_history` ("created_at" desc,"delegation_id" desc);--> statement-breakpoint
CREATE INDEX `delegation_history_settled` ON `delegation_history` ("settled_at" desc,"delegation_id" desc);