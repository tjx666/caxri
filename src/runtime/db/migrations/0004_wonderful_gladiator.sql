ALTER TABLE `projects` ADD `order_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `projects_order` ON `projects` (`order_index`,`created_at`,`id`);