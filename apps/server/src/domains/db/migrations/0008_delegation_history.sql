CREATE TABLE `delegation_edges` (
	`session_id` text PRIMARY KEY NOT NULL,
	`parent_session_id` text NOT NULL,
	`relation` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "delegation_edges_relation" CHECK("delegation_edges"."relation" IN ('delegated', 'handoff', 'consult'))
);
--> statement-breakpoint
CREATE INDEX `delegation_edges_parent` ON `delegation_edges` (`parent_session_id`);--> statement-breakpoint
CREATE TABLE `delegation_history` (
	`delegation_id` text PRIMARY KEY NOT NULL,
	`root_delegation_id` text NOT NULL,
	`retry_of` text,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`owner_terminal_id` text,
	`owner_principal_hash` text,
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
	CONSTRAINT "delegation_history_outcome" CHECK("delegation_history"."outcome" IN ('completed', 'human_intervened', 'interrupted', 'failed', 'answer_unavailable')),
	CONSTRAINT "delegation_history_failure" CHECK("delegation_history"."failure" IN ('rate_limited', 'authentication_failed', 'output_limit', 'startup_not_ready', 'startup_waiting', 'submission_unconfirmed', 'provider_failed', 'permission_required', 'target_changed', 'session_changed', 'human_input', 'host_reset', 'result_missing', 'payload_overflow', 'launch_failed', 'hooks_required', 'correlation_missing', 'quota_exhausted', 'caller_stopped', 'target_not_ready', 'target_busy')),
	CONSTRAINT "delegation_history_summary_source" CHECK("delegation_history"."summary_source" IN ('authored', 'excerpt')),
	CONSTRAINT "delegation_history_usage_scope" CHECK("delegation_history"."usage_scope" IN ('main-thread', 'provider-task')),
	CONSTRAINT "delegation_history_outcome_failure" CHECK("delegation_history"."outcome" <> 'completed' OR "delegation_history"."failure" IS NULL),
	CONSTRAINT "delegation_history_summary_pair" CHECK(("delegation_history"."summary" IS NULL) = ("delegation_history"."summary_source" IS NULL)),
	CONSTRAINT "delegation_history_summary_completed" CHECK("delegation_history"."summary" IS NULL OR "delegation_history"."outcome" = 'completed'),
	CONSTRAINT "delegation_history_compacted_text" CHECK("delegation_history"."compacted_at" IS NULL OR ("delegation_history"."title" IS NULL AND "delegation_history"."summary" IS NULL)),
	CONSTRAINT "delegation_history_settle_order" CHECK("delegation_history"."settled_at" >= "delegation_history"."created_at"),
	CONSTRAINT "delegation_history_scope_counters" CHECK("delegation_history"."usage_scope" IS NULL OR "delegation_history"."input_tokens" IS NOT NULL OR "delegation_history"."output_tokens" IS NOT NULL),
	CONSTRAINT "delegation_history_tokens" CHECK(("delegation_history"."input_tokens" IS NULL OR "delegation_history"."input_tokens" >= 0) AND ("delegation_history"."output_tokens" IS NULL OR "delegation_history"."output_tokens" >= 0) AND ("delegation_history"."cache_read_tokens" IS NULL OR "delegation_history"."cache_read_tokens" >= 0) AND ("delegation_history"."cache_write_tokens" IS NULL OR "delegation_history"."cache_write_tokens" >= 0) AND ("delegation_history"."reasoning_tokens" IS NULL OR "delegation_history"."reasoning_tokens" >= 0) AND ("delegation_history"."total_tokens" IS NULL OR "delegation_history"."total_tokens" >= 0))
);
--> statement-breakpoint
CREATE INDEX `delegation_history_owner_created` ON `delegation_history` (`owner_terminal_id`,"created_at" desc,"delegation_id" desc);--> statement-breakpoint
CREATE INDEX `delegation_history_created` ON `delegation_history` ("created_at" desc,"delegation_id" desc);--> statement-breakpoint
CREATE INDEX `delegation_history_settled` ON `delegation_history` ("settled_at" desc,"delegation_id" desc);
--> statement-breakpoint
-- Backfill: every live Session with a creator relation gets its edge, so work delegated before this migration stays
-- attributed if either Session is deleted later.
INSERT OR IGNORE INTO `delegation_edges` (`session_id`, `parent_session_id`, `relation`, `created_at`)
SELECT `id`, `created_by_session_id`, `created_by_relation`, `created_at` FROM `sessions`
WHERE `created_by_session_id` IS NOT NULL AND `created_by_relation` IS NOT NULL;
