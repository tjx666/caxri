-- Custom SQL migration file, put your code below! --
-- Generated empty by `drizzle-kit generate --custom`; this data step backfills the column 0013 added.
-- Every Session starts resolved except the ones the previous Activity view still listed as waiting on the
-- user (unread, an open question, a failure, or a turn finished within its 15-minute window): those keep
-- their latest attention generation pending, so upgrading neither floods Needs attention with old history
-- nor drops work the user had not acted on yet.
UPDATE `sessions` SET `resolved_attention_generation` = CASE
	WHEN `attention_generation` > 0 AND (
		`attention_generation` > `acknowledged_attention_generation`
		OR `agent_activity_state` IN ('waiting', 'failed')
		OR (`agent_activity_state` = 'completed' AND `session_activity_at` > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000)
	) THEN `attention_generation` - 1
	ELSE `attention_generation`
END;
