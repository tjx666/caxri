import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { agentChatRequestSchema } from './agent-chat-requests.js';

/**
 * Entries (Chats and PTY Terminals together) one `agentChat.pendingRequests` answer lists. Far more than anyone answers
 * at once; the popup shows one at a time and counts the rest.
 */
export const AGENT_CHAT_WAITING_MAX_CHATS = 50;

/**
 * Upper bound of the message excerpt that led to a pending request.
 */
export const AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH = 2_000;

export const agentChatWaitingChatSchema = z.strictObject({
    kind: z.literal('chat'),
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    /**
     * Every request the Chat is waiting on, oldest first, exactly as its projection holds them.
     */
    requests: z.array(agentChatRequestSchema).min(1).max(20),
    /**
     * The user's latest message before the request, so a card answered away from the Chat still says what the Agent is
     * working on. Absent when the projection holds no user message (a resumed Chat whose history was not loaded).
     */
    prompt: z.string().min(1).max(AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH).optional(),
});

/**
 * A PTY Terminal Agent waiting on the user. Server Core knows only that it waits (from the validated lifecycle hooks),
 * never what it asks, and a Terminal prompt cannot be answered from outside the PTY, so the entry carries no request:
 * the popup can only take the user to the Terminal.
 */
export const agentChatWaitingTerminalSchema = z.strictObject({
    kind: z.literal('terminal'),
    sessionId: identifierSchema,
    terminalId: identifierSchema,
});

export const agentChatWaitingEntrySchema = z.discriminatedUnion('kind', [
    agentChatWaitingChatSchema,
    agentChatWaitingTerminalSchema,
]);

export const agentChatWaitingMethods = {
    /**
     * Everything waiting on the user, for the global popup that answers an Agent the user is not looking at: every live
     * Chat with a request (`kind: 'chat'`, answerable in place), then every PTY Terminal Agent the Session lifecycle
     * marks `waiting` (`kind: 'terminal'`, open-only). Read only from Server Core's in-memory projections and stored
     * Session rows, so it never starts, resumes, or wakes a provider: a Chat with no running provider has no pending
     * request to list. The Renderer re-reads it when an `agentChat.patch` changes a Chat's `requests` and when a
     * Session's Agent activity state changes. The text is user content: the Server never persists, caches, or logs it.
     */
    'agentChat.pendingRequests': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({}),
        result: z.strictObject({
            entries: z.array(agentChatWaitingEntrySchema).max(AGENT_CHAT_WAITING_MAX_CHATS),
        }),
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentChatWaitingChat = z.infer<typeof agentChatWaitingChatSchema>;
export type AgentChatWaitingTerminal = z.infer<typeof agentChatWaitingTerminalSchema>;
export type AgentChatWaitingEntry = z.infer<typeof agentChatWaitingEntrySchema>;
