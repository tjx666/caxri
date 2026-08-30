ALTER TABLE `sessions` ADD `auto_naming_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_auto_title` text;