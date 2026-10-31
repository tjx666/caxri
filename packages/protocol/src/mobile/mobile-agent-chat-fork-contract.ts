import { z } from 'zod';

import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const terminalTarget = { terminalId: identifierSchema };

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
     * The phone's Continue in Another Agent, forwarded to `agentChat.continueInAgent` as the menu's `manual`
     * continuation, so a retry opens the same new Session instead of creating another.
     */
    'mobile.agentChat.continueInAgent': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: z.strictObject({
            ...terminalTarget,
            provider: agentChatMethods['agentChat.continueInAgent'].params.shape.provider,
        }),
        result: z.strictObject({ sessionId: identifierSchema }),
    },
} as const satisfies Record<string, MethodSpec>;
