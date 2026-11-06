ALTER TABLE `sessions` ADD `resolved_attention_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `attention_resolved_at` integer;