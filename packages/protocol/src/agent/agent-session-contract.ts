import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { sessionRenameTitleSchema } from '../domain/session.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';

const sessionTargetSchema = z.strictObject({ sessionId: identifierSchema });
const sessionResultSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * Longest message one relay carries; well under a Chat message's own bound, leaving room for the source line.
 */
export const MAX_AGENT_SESSION_SEND_TEXT_LENGTH = 32_000;

const agentSessionSendTextSchema = z
    .string()
    .max(MAX_AGENT_SESSION_SEND_TEXT_LENGTH)
    .refine((text) => text.trim().length > 0, 'Message text must not be empty');

/**
 * `delivery` names the target surface: `chat` went through the Chat composer's Enter path, `terminal` was submitted to
 * a Terminal Agent's prompt.
 */
const agentSessionSendResultSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    delivery: z.enum(['chat', 'terminal']),
});

/**
 * The relayed message as the target Agent reads it: a source line naming the Session that relayed it on the user's
 * behalf, then the text verbatim, so neither the Agent nor the user mistakes it for something typed there.
 */
export function relayedSessionMessage(sourceTitle: string | undefined, text: string): string {
    const source = sourceTitle?.trim() ? `Session "${sourceTitle.trim()}"` : 'another Session';
    return `[Caxri] Relayed from ${source} at the user's request:\n\n${text}`;
}

/**
 * One management step on a Session an Agent created. Archive and restore are the sidebar's own reversible operations;
 * restore puts the Session back at the top of its Project, where the user sees it again.
 */
const agentSessionOperationSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('rename'), title: sessionRenameTitleSchema }),
    z.strictObject({ action: z.literal('archive') }),
    z.strictObject({ action: z.literal('unarchive') }),
]);

/**
 * Lets an Agent tidy up the Sessions its own Session created through `agent delegate create --new-session`: give one a
 * better title, archive it when the work is done, or restore it. Any other Session, including the caller's own and
 * every Session the user created, is `NOT_FOUND`. Caxri Bot is held to the Sessions it still owns, so a Session the
 * user took back or handed over stays out of reach.
 */
export const agentSessionMethods = {
    'agent.session.rename': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema.extend({ title: sessionRenameTitleSchema }),
        result: sessionResultSchema,
    },
    'agent.session.archive': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema,
        result: sessionResultSchema,
    },
    'agent.session.unarchive': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema,
        result: sessionResultSchema,
    },
    /**
     * Relays a message the user asked the caller to pass on into another of the user's Sessions, delivered exactly as
     * if the user typed it into that Session's Agent and pressed Enter: an idle Agent starts a turn with it, a running
     * Chat takes it in after its current tool call. Unlike the rename family this reaches every visible Session, not
     * only the ones the caller created, so the user never has to copy text between Sessions by hand.
     */
    'agent.session.send': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema.extend({ text: agentSessionSendTextSchema }),
        result: agentSessionSendResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Core resolves the caller's Terminal from its authenticated Endpoint; the caller never names its own Session.
 */
export const agentSessionInternalMethods = {
    'agent.session.manageInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            principal: principalSchema,
            callerTerminalId: identifierSchema,
            sessionId: identifierSchema,
            operation: agentSessionOperationSchema,
        }),
        result: sessionResultSchema,
    },
    'agent.session.sendInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            principal: principalSchema,
            callerTerminalId: identifierSchema,
            sessionId: identifierSchema,
            text: agentSessionSendTextSchema,
        }),
        result: agentSessionSendResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentSessionOperation = z.infer<typeof agentSessionOperationSchema>;
