ALTER TABLE `sessions` ADD `attention_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `read_attention_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_attention_kind` text;