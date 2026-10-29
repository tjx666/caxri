import { z } from 'zod';

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
