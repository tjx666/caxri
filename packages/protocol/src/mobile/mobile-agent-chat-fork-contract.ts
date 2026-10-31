import { z } from 'zod';

import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const terminalTarget = { terminalId: identifierSchema };

/**
 * Where a phone's Continue in Another Agent started: the Session menu, the card of a turn a usage limit failed, or the
 * usage guard's banner.
 */
const mobileContinuationOriginSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('menu') }),
    z.strictObject({
        kind: z.literal('usageLimit'),
        turnId: agentChatMethods['agentChat.continueInAgent'].params.shape.turnId.unwrap(),
    }),
    z.strictObject({ kind: z.literal('usageGuard') }),
]);
export type MobileContinuationOrigin = z.infer<typeof mobileContinuationOriginSchema>;

/**
 * A phone's Fork Session and Continue in Another Agent: both copy a granted Chat's work into a new Session of the same
 * Project, which the phone then opens.
 */
export const mobileAgentChatForkMethods = {
    /**
     * The phone's Fork Session, forwarded to `agentChat.fork` without an `itemId`: copies the whole conversation into a
     * new Session of the same Project, which the phone then opens. A running turn or a Chat with no turn yet fails with
     * `CONFLICT` before anything is created.
     */
    'mobile.agentChat.fork': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: z.strictObject(terminalTarget),
        result: agentChatMethods['agentChat.fork'].result,
    },
    /**
     * The providers Continue in Another Agent lists for this Chat, forwarded to `agentChat.continuationTargets`.
     */
    'mobile.agentChat.continuationTargets': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject(terminalTarget),
        result: agentChatMethods['agentChat.continuationTargets'].result,
    },
    /**
     * The phone's Continue in Another Agent, forwarded to `agentChat.continueInAgent`. `origin` names where the user
     * started it, which decides the continuation Desktop's same control would send: the Session menu's `manual`
     * continuation (the default), a usage-limit card's failed turn, or the usage guard's "Open in another Agent". The
     * same origin always resolves to the same new Session, so a retry opens it instead of creating another.
     */
    'mobile.agentChat.continueInAgent': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: z.strictObject({
            ...terminalTarget,
            provider: agentChatMethods['agentChat.continueInAgent'].params.shape.provider,
            origin: mobileContinuationOriginSchema.optional(),
        }),
        result: z.strictObject({ sessionId: identifierSchema }),
    },
} as const satisfies Record<string, MethodSpec>;
