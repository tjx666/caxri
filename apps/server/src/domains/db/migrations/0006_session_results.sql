CREATE TABLE `session_results` (
	`session_id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`summary` text NOT NULL,
	`summary_source` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_results_summary_source" CHECK("session_results"."summary_source" IN ('authored', 'excerpt'))
);
