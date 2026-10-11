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
