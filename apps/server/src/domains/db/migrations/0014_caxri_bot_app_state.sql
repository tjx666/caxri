-- Agent Commander was renamed to Caxri Bot: carry its app_state cells over to the renamed keys.
UPDATE `app_state` SET `key` = 'caxriBot' WHERE `key` = 'agentCommander';--> statement-breakpoint
UPDATE `app_state` SET `key` = 'botAgent' WHERE `key` = 'commanderAgent';--> statement-breakpoint
UPDATE `app_state` SET `key` = 'botHandovers' WHERE `key` = 'commanderHandovers';--> statement-breakpoint
UPDATE `app_state`
SET `value_json` = json_set(
	json_remove(`value_json`, '$.agentCommander'),
	'$.caxriBot',
	json(json_extract(`value_json`, '$.agentCommander'))
)
WHERE `key` = 'auxiliaryWindowState' AND json_type(`value_json`, '$.agentCommander') = 'object';
