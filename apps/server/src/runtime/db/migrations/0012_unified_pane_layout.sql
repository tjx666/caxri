PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state_version` integer DEFAULT 2 NOT NULL,
	`workbench_state_json` text DEFAULT '{}' NOT NULL,
	`inspector_mode` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session_state`("session_id", "state_version", "workbench_state_json", "inspector_mode") SELECT "session_id", "state_version", "workbench_state_json", "inspector_mode" FROM `session_state`;--> statement-breakpoint
DROP TABLE `session_state`;--> statement-breakpoint
ALTER TABLE `__new_session_state` RENAME TO `session_state`;--> statement-breakpoint
UPDATE `session_state` SET `state_version` = 2, `workbench_state_json` = '{}';--> statement-breakpoint
PRAGMA foreign_keys=ON;