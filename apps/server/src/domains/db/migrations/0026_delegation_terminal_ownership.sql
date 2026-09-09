ALTER TABLE `agent_delegations` ADD `terminal_id` text;--> statement-breakpoint
CREATE INDEX `agent_delegations_terminal` ON `agent_delegations` (`terminal_id`);--> statement-breakpoint
-- Preserve indexed ownership for delegations created before explicit recovery was introduced.
UPDATE `agent_delegations` SET `terminal_id` = json_extract(`record_json`, '$.receipt.terminalId');
