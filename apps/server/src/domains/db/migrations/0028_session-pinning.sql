ALTER TABLE `sessions` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `pinned_order` integer DEFAULT 0 NOT NULL;