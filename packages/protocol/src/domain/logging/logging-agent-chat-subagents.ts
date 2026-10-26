/**
 * Sidebar subagent summary events of the structured-log registry (`logEventCatalog.agentChatSubagents` in
 * `./logging.ts`). None carries a subagent title or transcript text: only closed reasons and counts.
 */
export const agentChatSubagentLogEvents = {
    /**
     * Server Core start rewrote persisted `running` subagent summaries to `stopped`, because their provider process
     * ended with the previous Server Core. Carries a closed `reason` (`serverStart`) and the `terminals` touched.
     */
    reconciled: 'agent_chat.subagents_reconciled',
} as const;
