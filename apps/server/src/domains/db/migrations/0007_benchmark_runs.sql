CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`document_json` text NOT NULL,
	CONSTRAINT "benchmark_run_status" CHECK("benchmark_runs"."status" IN ('running', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `benchmark_runs_created` ON `benchmark_runs` (`created_at`);