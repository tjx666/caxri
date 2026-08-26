ALTER TABLE `session_state` ADD `workbench_state_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `workbench_project_id` text REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `workbench_root_device` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `workbench_root_inode` text;--> statement-breakpoint
CREATE INDEX `sessions_workbench_project` ON `sessions` (`workbench_project_id`);