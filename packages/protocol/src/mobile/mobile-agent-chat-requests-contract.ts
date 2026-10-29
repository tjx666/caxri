import { z } from 'zod';

import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { agentChatRequestSchema } from '../agent/agent-chat-requests.js';
import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * The requests the Chat is waiting on, for the Sessions list's approval cards. Unlike `mobile.agentChat.read` it reads
 * only Core's in-memory projection, so a list poll never starts or resumes a provider; a Chat with no running provider
 * has no pending request and answers an empty list. Answered through `mobile.agentChat.respond`.
 */
export const mobileAgentChatRequestsMethod = {
    ...commandPolicy('server', 'read', ['sessions.read']),
    params: z.strictObject({ terminalId: identifierSchema }),
    result: z.strictObject({ requests: z.array(agentChatRequestSchema).max(20) }),
} as const satisfies MethodSpec;

/**
 * Approves a Codex Chat's proposed plan, the phone's equivalent of the Desktop card's Start Building: forwarded to
 * `agentChat.implementPlan`, which turns plan mode off and sends the build turn in one Server step. Control access,
 * like `mobile.agentChat.respond`, since it starts the Agent's work.
 */
export const mobileAgentChatImplementPlanMethod = {
    ...commandPolicy('server', 'control', ['terminals.steer']),
    params: agentChatMethods['agentChat.implementPlan'].params,
    result: z.null(),
} as const satisfies MethodSpec;
