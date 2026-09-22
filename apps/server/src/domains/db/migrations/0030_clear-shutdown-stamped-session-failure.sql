-- Clears the `failed` activity state an unclean Caxri shutdown used to stamp on every live Session.
-- That stamp described Caxri's own process, not the Agent conversation, and no code path ever cleared it, so these
-- rows would otherwise sit in Activity's Failed group forever. See https://github.com/tjx666/caxri/issues/1124.
--
-- The pre-crash state was overwritten and cannot be read back, but `last_session_activity_reason` survived it and
-- records the last real Agent event, so it recovers the state for the common case instead of flattening everything.
-- `failed` itself stays a valid state: a provider-reported turn failure and a crashed Agent process still use it.
UPDATE `sessions`
SET `last_activity_state` = CASE `last_session_activity_reason`
    WHEN 'agent_completed' THEN 'completed'
    WHEN 'agent_waiting' THEN 'waiting'
    WHEN 'agent_failed' THEN 'failed'
    ELSE 'unknown'
END
WHERE `last_activity_state` = 'failed';
