import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { identifierSchema } from './identifiers.js';

/**
 * Conversations one `session.agentHistory` reply lists, newest binding first. The hover card that shows them has room
 * for a handful; older ones stay reachable through Session search.
 */
export const MAX_SESSION_AGENT_HISTORY_ENTRIES = 12;

export const sessionAgentHistoryEntrySchema = z.object({
    provider: agentProviderSchema,
    agentSessionId: z.string().min(1).max(1_024),
    /**
     * The conversation's title from Session search's index; absent while the index has none or is unavailable.
     */
    title: z.string().max(1_024).optional(),
    /**
     * When Caxri last recorded this conversation as bound to one of the Session's Terminals.
     */
    boundAt: z.number().int().nonnegative(),
    /**
     * The Session's Terminal currently bound to the conversation; absent once that Terminal was closed or moved on to
     * another conversation.
     */
    terminalId: identifierSchema.optional(),
});
export type SessionAgentHistoryEntry = z.infer<typeof sessionAgentHistoryEntrySchema>;

export const sessionAgentHistoryResultSchema = z.object({
    entries: z.array(sessionAgentHistoryEntrySchema).max(MAX_SESSION_AGENT_HISTORY_ENTRIES),
});
export type SessionAgentHistoryResult = z.infer<typeof sessionAgentHistoryResultSchema>;

export const sessionReopenConversationParametersSchema = z.object({
    sessionId: identifierSchema,
    provider: agentProviderSchema,
    agentSessionId: z.string().trim().min(1).max(1_024),
});

export const sessionReopenConversationResultSchema = z.object({
    terminalId: identifierSchema,
});
