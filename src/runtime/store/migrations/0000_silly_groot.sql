CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`display_title` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_path_unique` ON `projects` (`root_path`);--> statement-breakpoint
CREATE TABLE `session_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`open_tabs_json` text NOT NULL,
	`active_tab_json` text,
	`inspector_mode` text NOT NULL,
	`layout_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`primary_agent_terminal_id` text,
	`last_activity_state` text DEFAULT 'idle' NOT NULL,
	`layout_version` integer DEFAULT 2 NOT NULL,
	`display_title` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_project_activity` ON `sessions` (`project_id`,"last_opened_at" DESC);--> statement-breakpoint
CREATE TABLE `terminal_snapshots` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`encoding_version` integer NOT NULL,
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
	`title` text NOT NULL,
	`icon` text NOT NULL,
	`order_index` integer NOT NULL,
	`layout_node_id` text NOT NULL,
	`agent_session_id` text,
	`last_process_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `terminals_session_order` ON `terminals` (`session_id`,`order_index`,`id`);